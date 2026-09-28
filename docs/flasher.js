/*
 * Intel HEX parsing + STK500 (optiboot) flashing, shared by the web flasher
 * (docs/flash.html) and the Node end-to-end test (tools/flash_test.js).
 *
 * Works in both worlds: `require()` it in Node, or include it with a plain
 * <script> tag and use `window.LightbarFlasher`.
 *
 * The transport is deliberately minimal so it can be backed by Web Serial in
 * the browser or by a pyserial bridge under Node:
 *
 *   write(bytes: Uint8Array) => Promise<void>
 *   reader: ByteReader fed by a background read loop
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LightbarFlasher = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // --- STK500 constants ----------------------------------------------------

  const STK_GET_SYNC = 0x30;
  const STK_LOAD_ADDRESS = 0x55;
  const STK_PROG_PAGE = 0x64;
  const STK_READ_PAGE = 0x74;
  const STK_READ_SIGN = 0x75;
  const STK_LEAVE_PROGMODE = 0x51;
  const STK_INSYNC = 0x14;
  const STK_OK = 0x10;
  const CRC_EOP = 0x20;
  const FLASH_TYPE = 0x46; // 'F'

  const ATmega328P_SIGNATURE = [0x1e, 0x95, 0x0f];
  const ATmega328P_PAGE_SIZE = 128;
  const ATmega328P_FLASH_SIZE = 32768;

  // --- Intel HEX -----------------------------------------------------------

  /**
   * Parse Intel HEX text into a contiguous Uint8Array covering 0..maxAddress.
   * Throws on malformed records or checksum mismatches.
   */
  function parseIntelHex(text) {
    const memory = new Map();
    let base = 0;
    let maxAddress = 0;
    let sawEof = false;
    let records = 0;

    const lines = String(text).split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n].trim();
      if (line === "") continue;
      if (line[0] !== ":") throw new Error(`第 ${n + 1} 行不是 Intel HEX 记录`);

      const raw = [];
      for (let i = 1; i + 1 < line.length + 1; i += 2) {
        const pair = line.substr(i, 2);
        if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
          throw new Error(`第 ${n + 1} 行有非法字符: ${pair}`);
        }
        raw.push(parseInt(pair, 16));
      }

      const length = raw[0];
      const address = (raw[1] << 8) | raw[2];
      const type = raw[3];
      if (raw.length !== 5 + length) {
        throw new Error(`第 ${n + 1} 行长度不对`);
      }

      let sum = 0;
      for (let i = 0; i < 4 + length; i++) sum += raw[i];
      if (((sum + raw[4 + length]) & 0xff) !== 0) {
        throw new Error(`第 ${n + 1} 行校验和错误`);
      }
      records++;

      if (type === 0x00) {
        for (let i = 0; i < length; i++) {
          const addr = base + address + i;
          memory.set(addr, raw[4 + i]);
          if (addr + 1 > maxAddress) maxAddress = addr + 1;
        }
      } else if (type === 0x01) {
        sawEof = true;
        break;
      } else if (type === 0x02) {
        base = ((raw[4] << 8) | raw[5]) << 4;
      } else if (type === 0x04) {
        base = ((raw[4] << 8) | raw[5]) << 16;
      } else if (type === 0x03 || type === 0x05) {
        // start address record, irrelevant for flashing
      } else {
        throw new Error(`第 ${n + 1} 行未知的记录类型 0x${type.toString(16)}`);
      }
    }

    if (!sawEof) throw new Error("HEX 文件缺少结束记录 (:00000001FF)");
    if (maxAddress === 0) throw new Error("HEX 文件里没有数据");

    const out = new Uint8Array(maxAddress).fill(0xff);
    memory.forEach((value, addr) => { out[addr] = value; });
    return { bytes: out, records };
  }

  /** Pad to a whole number of pages with 0xFF, as the bootloader requires. */
  function padToPage(bytes, pageSize) {
    const remainder = bytes.length % pageSize;
    if (remainder === 0) return bytes;
    const padded = new Uint8Array(bytes.length + (pageSize - remainder));
    padded.fill(0xff);
    padded.set(bytes);
    return padded;
  }

  // --- byte reader ---------------------------------------------------------

  /** Fed by a background read loop; awaited by the flashing sequence. */
  class ByteReader {
    constructor() {
      this.buf = [];
      this.waiting = null;
    }

    push(chunk) {
      for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]);
      if (this.waiting && this.buf.length) {
        const w = this.waiting;
        this.waiting = null;
        w();
      }
    }

    clear() { this.buf.length = 0; }

    async _waitForData(timeoutMs) {
      if (this.buf.length) return true;
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.waiting) this.waiting = null;
          resolve(false);
        }, timeoutMs);
        this.waiting = () => { clearTimeout(timer); resolve(true); };
      });
    }

    /** One byte, or null on timeout. */
    async readByte(timeoutMs) {
      await this._waitForData(timeoutMs);
      return this.buf.length ? this.buf.shift() : null;
    }

    /** Exactly n bytes, or null if they did not all arrive in time. */
    async readBytes(n, timeoutMs) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const b = await this.readByte(timeoutMs);
        if (b === null) return null;
        out.push(b);
      }
      return out;
    }
  }

  // --- STK500 --------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function expectAck(write, reader, payload, timeoutMs) {
    reader.clear();
    await write(new Uint8Array(payload));
    const a = await reader.readByte(timeoutMs);
    if (a !== STK_INSYNC) return false;
    const b = await reader.readByte(timeoutMs);
    return b === STK_OK;
  }

  /** Optiboot waits about a second after reset; retry until it answers. */
  async function sync(write, reader, attempts, onLog) {
    for (let i = 0; i < attempts; i++) {
      if (await expectAck(write, reader, [STK_GET_SYNC, CRC_EOP], 400)) return true;
      if (onLog && i === 3) onLog("仍在等待 bootloader 响应…（可以重新插拔一下 USB）");
      await sleep(80);
    }
    return false;
  }

  async function readSignature(write, reader) {
    reader.clear();
    await write(new Uint8Array([STK_READ_SIGN, CRC_EOP]));
    const r = await reader.readBytes(5, 600);
    if (r && r[0] === STK_INSYNC && r[4] === STK_OK) return [r[1], r[2], r[3]];
    return null;
  }

  async function loadAddress(write, reader, byteAddress) {
    // STK500 addresses are word addresses.
    const word = byteAddress >> 1;
    return await expectAck(
      write, reader,
      [STK_LOAD_ADDRESS, word & 0xff, (word >> 8) & 0xff, CRC_EOP],
      800
    );
  }

  async function programPage(write, reader, data) {
    const msg = [STK_PROG_PAGE, (data.length >> 8) & 0xff, data.length & 0xff, FLASH_TYPE];
    for (let i = 0; i < data.length; i++) msg.push(data[i]);
    msg.push(CRC_EOP);
    return await expectAck(write, reader, msg, 3000);
  }

  async function readPage(write, reader, length) {
    reader.clear();
    await write(new Uint8Array(
      [STK_READ_PAGE, (length >> 8) & 0xff, length & 0xff, FLASH_TYPE, CRC_EOP]
    ));
    const r = await reader.readBytes(length + 2, 2000);
    if (!r || r[0] !== STK_INSYNC || r[r.length - 1] !== STK_OK) return null;
    return r.slice(1, 1 + length);
  }

  /**
   * Flash a HEX image.
   *
   * opts:
   *   write      (Uint8Array) => Promise<void>
   *   reader     ByteReader
   *   hex        Intel HEX text
   *   verify     read every page back (default true)
   *   pageSize   default 128 (ATmega328P)
   *   onLog      (msg) => void
   *   onProgress (fraction, label) => void
   *
   * Resolves with { bytes, pages, signature }.
   */
  async function flash(opts) {
    const write = opts.write;
    const reader = opts.reader;
    const onLog = opts.onLog || function () {};
    const onProgress = opts.onProgress || function () {};
    const pageSize = opts.pageSize || ATmega328P_PAGE_SIZE;
    const verify = opts.verify !== false;

    const parsed = parseIntelHex(opts.hex);
    const image = padToPage(parsed.bytes, pageSize);
    const pages = image.length / pageSize;

    onLog(`解析 HEX：${parsed.records} 条记录，${parsed.bytes.length} 字节程序`);
    onLog(`按 ${pageSize} 字节分页，补 0xFF 到 ${pages} 页`);

    if (image.length > ATmega328P_FLASH_SIZE) {
      throw new Error(`固件 ${image.length} 字节，超过 ATmega328P 的 ${ATmega328P_FLASH_SIZE} 字节`);
    }

    onProgress(0, "正在握手…");
    if (!(await sync(write, reader, 25, onLog))) {
      throw new Error("bootloader 没有响应。请确认选对了串口，或拔插一下 USB 再试。");
    }
    onLog("已同步到 bootloader ✓");

    const signature = await readSignature(write, reader);
    if (signature) {
      const hex = signature.map((b) => b.toString(16).padStart(2, "0")).join("");
      const expected = ATmega328P_SIGNATURE.map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hex !== expected) {
        throw new Error(`芯片签名是 0x${hex}，期望 0x${expected}（ATmega328P）。已中止。`);
      }
      onLog(`芯片签名 0x${hex} ✓ (ATmega328P)`);
    } else {
      onLog("读不到芯片签名，继续（不影响烧录）");
    }

    for (let page = 0; page < pages; page++) {
      const address = page * pageSize;
      if (!(await loadAddress(write, reader, address))) {
        throw new Error(`第 ${page} 页设置地址失败 (0x${address.toString(16)})`);
      }
      const chunk = image.subarray(address, address + pageSize);
      if (!(await programPage(write, reader, chunk))) {
        throw new Error(`第 ${page} 页写入失败 (0x${address.toString(16)})`);
      }
      onProgress((page + 1) / pages * (verify ? 0.8 : 1), `写入 ${page + 1}/${pages}`);
    }
    onLog(`写入完成：${pages} 页 ✓`);

    if (verify) {
      for (let page = 0; page < pages; page++) {
        const address = page * pageSize;
        if (!(await loadAddress(write, reader, address))) {
          throw new Error(`校验时第 ${page} 页设置地址失败`);
        }
        const got = await readPage(write, reader, pageSize);
        if (!got) throw new Error(`校验时第 ${page} 页读取失败`);
        const want = image.subarray(address, address + pageSize);
        for (let i = 0; i < pageSize; i++) {
          if (got[i] !== want[i]) {
            throw new Error(
              `校验失败 @0x${(address + i).toString(16)}: 读到 0x${got[i].toString(16)}，` +
              `期望 0x${want[i].toString(16)}`
            );
          }
        }
        onProgress(0.8 + (page + 1) / pages * 0.2, `校验 ${page + 1}/${pages}`);
      }
      onLog("校验通过 ✓");
    }

    reader.clear();
    await write(new Uint8Array([STK_LEAVE_PROGMODE, CRC_EOP]));
    onProgress(1, "完成");
    onLog("已退出 bootloader，固件开始运行");

    return { bytes: parsed.bytes.length, pages, signature };
  }

  return {
    parseIntelHex,
    padToPage,
    ByteReader,
    flash,
    constants: {
      STK_GET_SYNC, STK_LOAD_ADDRESS, STK_PROG_PAGE, STK_READ_PAGE,
      STK_READ_SIGN, STK_LEAVE_PROGMODE, STK_INSYNC, STK_OK, CRC_EOP,
      ATmega328P_SIGNATURE, ATmega328P_PAGE_SIZE, ATmega328P_FLASH_SIZE,
    },
  };
});
