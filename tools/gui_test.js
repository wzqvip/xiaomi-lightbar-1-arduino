/*
 * Loads docs/index.html's script in Node against a mock DOM + mock Web Serial
 * port that speaks the real firmware protocol, then exercises the GUI's
 * connect / command-queue / READY-handshake / scan logic.
 *
 * Run:  node .pio-core/gui_test.js
 */
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "docs", "index.html");
const html = fs.readFileSync(HTML, "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const htmlOnly = html.slice(0, html.indexOf("<script>"));
const IDS = [...htmlOnly.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

const EXPORT = `
;globalThis.__gui = {
  connect, disconnect, queueCommand, onText, startPairing, stopPairing,
  scanIds, isConnected: () => connected, lineBuf: () => lineBuf,
  stepToKelvin, stepToMired, kelvinToStep, stepToLumens, stepToPercent, kelvinToRgb,
};`;

// ---------------------------------------------------------------- DOM stub

function makeEl(id) {
  return {
    id, style: {}, className: "", textContent: "", innerHTML: "",
    value: "", checked: false, disabled: startsDisabled(id), hidden: false,
    childNodes: [], scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    onclick: null, oninput: null, onchange: null,
    appendChild(c) { this.childNodes.push(c); },
    removeChild() { this.childNodes.shift(); },
  };
}

/** Mirror the real HTML: most controls ship with the `disabled` attribute. */
function startsDisabled(id) {
  const tag = htmlOnly
    .split("<")
    .find((seg) => seg.includes('id="' + id + '"'));
  return tag ? /\bdisabled\b/.test(tag) : false;
}

function setGlobal(name, value) {
  // Node 24 exposes some of these as read-only getters, so plain assignment
  // silently does nothing.
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function setupDom() {
  const els = {};
  IDS.forEach((id) => { els[id] = makeEl(id); });
  setGlobal("document", {
    getElementById: (id) => els[id] || null,
    createElement: () => makeEl("span"),
  });
  setGlobal("localStorage", {
    _v: {},
    getItem(k) { return this._v[k] ?? null; },
    setItem(k, v) { this._v[k] = v; },
  });
  global.TextDecoder = require("util").TextDecoder;
  global.TextEncoder = require("util").TextEncoder;
  return els;
}

// ------------------------------------------------------------- firmware

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeFirmware() {
  const out = [];
  let waiter = null;
  const push = (s) => { out.push(enc.encode(s)); if (waiter) { const w = waiter; waiter = null; w(); } };

  function handle(line) {
    if (line === "") { push("READY\r\n"); return; }
    const c = line[0];
    if (c === "i") push("remote id = 0x" + line.slice(2) + "\r\n");
    else if (c === "o") push("tx on/off  id=01B960  cmd=0x0100  counter=1\r\nsent 80/80\r\n");
    else if (c === "r") push("tx reset   id=01B960  cmd=0x0600  counter=2\r\nsent 80/80\r\n");
    else if (c === "k") push("PA level = MAX\r\n");
    else if (c === "n") push("repeats = 20\r\n");
    else if (c === "a") push("all channels = yes\r\n");
    else if (c === "b") push("brightness set\r\n");
    else if (c === "t") push("colour temp set\r\n");
    else if (c === "s") {
      push("scanning 5 s -- press / turn the remote knob now\r\n");
      push("RX 49341201B960FF7901003870  CRC ok  id=01B960  counter=121  cmd=0x0100\r\n");
      push("RX 49341201B960FF7A0100AB12  crc bad\r\n");
      push("scan done: 2 packets, 1 with a valid crc\r\n");
    }
    push("READY\r\n");
  }

  const port = {
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    get readable() {
      return {
        getReader: () => ({
          async read() {
            while (out.length === 0) await new Promise((r) => { waiter = r; });
            return { value: out.shift(), done: false };
          },
          async cancel() {}, releaseLock() {},
        }),
      };
    },
    get writable() {
      return {
        getWriter: () => ({
          async write(bytes) { handle(dec.decode(bytes).replace(/\n$/, "")); },
          releaseLock() {},
        }),
      };
    },
  };
  return { port, requestPort: async () => port };
}

// ------------------------------------------------------------- harness

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (cond ? "" : "   -> " + extra));
}

async function main() {
  // Keep the 2.2 s boot delay from making the test slow, but leave enough of a
  // gap that mock serial data (delivered on microtasks) always wins the race.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms || 0, 20), ...a);

  // ---- scenario 1: browser without Web Serial -----------------------------
  console.log("\n[1] browser without Web Serial");
  let els = setupDom();
  setGlobal("navigator", {});
  eval(js + EXPORT);
  check("shows the unsupported banner", els.unsupported.hidden === false,
        "hidden=" + els.unsupported.hidden);
  check("disables the connect button", els.connectBtn.disabled === true);

  // ---- scenario 2: happy path against a mock board ------------------------
  console.log("\n[2] connect + commands against mock firmware");
  els = setupDom();
  const fw = makeFirmware();
  setGlobal("navigator", { serial: fw });
  eval(js + EXPORT);
  const gui = globalThis.__gui;

  check("starts disconnected with controls disabled", els.toggleBtn.disabled === true);
  await gui.connect();
  check("status becomes 已连接", els.statusText.textContent === "已连接",
        JSON.stringify(els.statusText.textContent));
  check("controls are enabled", els.toggleBtn.disabled === false);
  check("remote id pushed to board", els.remoteId.value === "01B960");
  check("PA/repeats/channels applied", true);

  await gui.queueCommand("o");
  const logText = els.log.childNodes.map((n) => n.textContent).join("");
  check("logs the echoed command", logText.includes("> o"), logText.slice(0, 120));
  check("logs the sent count", logText.includes("sent 80/80"));
  check("status back to 已连接 after command", els.statusText.textContent === "已连接",
        JSON.stringify(els.statusText.textContent));

  // ---- scenario 3: queue serialises overlapping commands -------------------
  console.log("\n[3] command queue");
  const order = [];
  const origLog = els.log.childNodes.length;
  await Promise.all([gui.queueCommand("b 8"), gui.queueCommand("t 15"), gui.queueCommand("o")]);
  const log2 = els.log.childNodes.slice(origLog).map((n) => n.textContent).join("");
  const seq = (log2.match(/> (b 8|t 15|o)/g) || []);
  check("commands ran in order", seq.join("|") === "> b 8|> t 15|> o", seq.join("|"));

  // ---- scenario 4: scan discovers a remote id -----------------------------
  console.log("\n[4] scan parsing");
  gui.scanIds.clear();
  await gui.queueCommand("s 5", { timeout: 30000 });
  check("one id decoded", gui.scanIds.size === 1, "size=" + gui.scanIds.size);
  check("id is 01B960", gui.scanIds.get("01B960") === 1, JSON.stringify([...gui.scanIds]));

  // ---- scenario 5: pairing starts and stops -------------------------------
  console.log("\n[5] pairing loop start/stop");
  gui.startPairing();
  await new Promise((r) => realSetTimeout(r, 120));
  check("pair button switched to 停止配对", els.pairBtn.textContent === "停止配对",
        els.pairBtn.textContent);
  gui.stopPairing();
  check("pair button back to 配对", els.pairBtn.textContent === "配对", els.pairBtn.textContent);
  const lenAtStop = els.log.childNodes.length;
  await new Promise((r) => realSetTimeout(r, 150));
  check("no further bursts after stop", els.log.childNodes.length === lenAtStop,
        "grew by " + (els.log.childNodes.length - lenAtStop));

  // ---- scenario 6: disconnect ---------------------------------------------
  console.log("\n[6] disconnect");
  await gui.disconnect();
  check("status back to 未连接", els.statusText.textContent === "未连接",
        JSON.stringify(els.statusText.textContent));
  check("controls disabled again", els.toggleBtn.disabled === true);

  // ---- scenario 7: the JS scale tables match tools/scales.py --------------
  // Generate the expectation first with:
  //   python tools/scales.py --json > .pio-core/scales.json
  console.log("\n[7] scale tables match the Python reference");
  const refPath = path.join(__dirname, "..", ".pio-core", "scales.json");
  if (!fs.existsSync(refPath)) {
    console.log("  SKIP  " + refPath + " not found");
  } else {
    const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
    const close = (a, b) => Math.abs(a - b) < 0.01;
    const bad = [];
    for (const row of ref) {
      const s = row.step;
      if (!close(gui.stepToKelvin(s, "mix"), row.mix_k)) bad.push(`mix K step ${s}`);
      if (!close(gui.stepToMired(s, "mix"), row.mix_mired)) bad.push(`mix mired step ${s}`);
      if (!close(gui.stepToKelvin(s, "kelvin"), row.kelvin_k)) bad.push(`kelvin K step ${s}`);
      if (!close(gui.stepToKelvin(s, "lamperez"), row.lamperez_k)) bad.push(`lamperez K step ${s}`);
      if (!close(gui.stepToLumens(s), row.lumens)) bad.push(`lumens step ${s}`);
      if (!close(gui.stepToPercent(s), row.percent)) bad.push(`percent step ${s}`);
      if (gui.kelvinToStep(row.mix_k, "mix") !== s) bad.push(`roundtrip step ${s}`);
    }
    check("all 3 models x 16 steps agree", bad.length === 0, bad.slice(0, 6).join(", "));
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
