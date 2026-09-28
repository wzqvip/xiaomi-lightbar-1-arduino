/*
 * End-to-end test of the web flasher's STK500 implementation against real
 * hardware. It drives the actual Arduino bootloader through a pyserial bridge
 * using the exact same docs/flasher.js the browser loads.
 *
 *   node tools/flash_test.js COM42 [path/to/firmware.hex]
 *
 * This really does reflash the board, so make sure the connected device is the
 * light bar controller.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const flasher = require(path.join(__dirname, "..", "docs", "flasher.js"));

const PORT = process.argv[2] || "COM42";
const HEX =
  process.argv[3] ||
  path.join(__dirname, "..", ".pio", "build", "nanoatmega328", "firmware.hex");
const PYTHON = process.env.PYSERIAL_PYTHON || "python";

function hexDump(bytes, limit) {
  return Array.from(bytes.slice(0, limit))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

async function main() {
  const hex = fs.readFileSync(HEX, "utf8");
  console.log(`port : ${PORT}`);
  console.log(`hex  : ${HEX} (${hex.length} bytes of text)\n`);

  const bridge = spawn(PYTHON, [path.join(__dirname, "serial_bridge.py"), PORT], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const reader = new flasher.ByteReader();
  bridge.stdout.on("data", (chunk) => reader.push(chunk));
  bridge.on("error", (err) => console.error("bridge error:", err.message));

  const write = (bytes) =>
    new Promise((resolve, reject) => {
      bridge.stdin.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()));
    });

  let lastLabel = "";
  try {
    const result = await flasher.flash({
      write,
      reader,
      hex,
      onLog: (m) => console.log("  " + m),
      onProgress: (fraction, label) => {
        if (label !== lastLabel) {
          lastLabel = label;
          process.stdout.write(`\r  ${(fraction * 100).toFixed(0).padStart(3)}%  ${label}      `);
        }
      },
    });
    process.stdout.write("\n");
    console.log("\nPASS  flashed and verified");
    console.log("      bytes   :", result.bytes);
    console.log("      pages   :", result.pages);
    console.log(
      "      sig     :",
      result.signature
        ? "0x" + result.signature.map((b) => b.toString(16).padStart(2, "0")).join("")
        : "(not read)"
    );
    return 0;
  } catch (err) {
    process.stdout.write("\n");
    console.error("\nFAIL  " + err.message);
    return 1;
  } finally {
    try { bridge.kill(); } catch (e) { /* already gone */ }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("harness error:", err);
    process.exit(2);
  }
);
