#!/usr/bin/env python3
"""Bridge stdin/stdout to a serial port as raw bytes.

Used by tools/flash_test.js to drive the real Arduino bootloader from Node with
exactly the same STK500 code the browser uses. Not needed for normal use --
the web flasher talks to Web Serial directly.

    node tools/flash_test.js COM42

Opening the port asserts DTR, which resets the board, so the bootloader's short
window starts as this process opens the port. Bytes written to stdin before
that are buffered by the pipe and forwarded immediately afterwards.
"""

from __future__ import annotations

import argparse
import sys
import threading


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("port", help="serial port, e.g. COM42 or /dev/ttyUSB0")
    ap.add_argument("--baud", type=int, default=115200)
    args = ap.parse_args()

    try:
        import serial
    except ImportError:
        print("pyserial is missing: python -m pip install pyserial", file=sys.stderr)
        return 2

    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.02)
    except Exception as exc:  # noqa: BLE001 - report whatever the OS said
        print(f"could not open {args.port}: {exc}", file=sys.stderr)
        return 3

    out = sys.stdout.buffer
    inp = sys.stdin.buffer
    read = getattr(inp, "read1", inp.read)
    stop = threading.Event()

    def pump() -> None:
        while not stop.is_set():
            try:
                data = ser.read(4096)
            except Exception:  # port yanked
                break
            if data:
                out.write(data)
                out.flush()
        stop.set()

    threading.Thread(target=pump, daemon=True).start()

    try:
        while not stop.is_set():
            chunk = read(4096)
            if not chunk:
                break
            ser.write(chunk)
    except (KeyboardInterrupt, ValueError, OSError):
        pass
    finally:
        stop.set()
        try:
            ser.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
