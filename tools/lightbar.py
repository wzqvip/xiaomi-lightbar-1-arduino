#!/usr/bin/env python3
"""Host driver for the xiaomi-lightbar-1-arduino firmware.

The sketch exposes a small line based protocol over the serial port, this
script wraps it so you do not have to type into a serial monitor.

    python tools/lightbar.py monitor
    python tools/lightbar.py scan --seconds 30
    python tools/lightbar.py --id 01B960 on
    python tools/lightbar.py --id 01B960 up
    python tools/lightbar.py --id 01B960 brightness 8

Requires pyserial:  python -m pip install pyserial
"""

from __future__ import annotations

import argparse
import re
import sys
import time

try:
    import serial
except ImportError:  # pragma: no cover
    sys.exit("pyserial is missing:  python -m pip install pyserial")

DEFAULT_PORT = "COM42"
DEFAULT_BAUD = 115200

# The sketch prints decoded remote ids as "id=01B960" on packets with a good crc.
ID_RE = re.compile(r"CRC ok\s+id=([0-9A-Fa-f]{6})")


def open_port(port: str, baud: int, reset: bool = False) -> serial.Serial:
    """Open the port without resetting the board unless asked to."""
    s = serial.Serial()
    s.port = port
    s.baudrate = baud
    s.timeout = 0.2
    if not reset:
        # Deassert DTR/RTS before opening so the auto-reset capacitor does not
        # reboot the sketch (which would also wipe the remote id held in RAM).
        s.dtr = False
        s.rts = False
    s.open()
    return s


def settle(s: serial.Serial, seconds: float = 2.3) -> None:
    """Opening the port pulses DTR and reboots the sketch; wait it out."""
    time.sleep(seconds)
    s.reset_input_buffer()


def read_lines(s: serial.Serial, deadline: float, echo: bool = True):
    """Yield decoded lines until `deadline` (a time.monotonic value)."""
    buf = b""
    while time.monotonic() < deadline:
        chunk = s.read(256)
        if not chunk:
            continue
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            text = line.decode("utf-8", "replace").rstrip("\r")
            if text.strip() == "READY":  # firmware completion sentinel
                continue
            if echo:
                print(text)
            yield text


def cmd_monitor(args) -> int:
    with open_port(args.port, args.baud, reset=True) as s:
        print(f"# listening on {args.port} - Ctrl-C to stop")
        try:
            read_lines(s, time.monotonic() + 86400)
        except KeyboardInterrupt:
            print("\n# stopped")
    return 0


def cmd_scan(args) -> int:
    with open_port(args.port, args.baud, reset=args.reset) as s:
        settle(s)
        s.write(b"i %s\n" % args.id.encode())

        print(f"# scanning for {args.seconds}s - operate the remote knob now")

        ids: dict[str, int] = {}
        s.write(f"s {args.seconds}\n".encode())
        deadline = time.monotonic() + args.seconds + 8
        for line in read_lines(s, deadline):
            m = ID_RE.search(line)
            if m:
                rid = m.group(1).upper()
                ids[rid] = ids.get(rid, 0) + 1

    print()
    if not ids:
        print("# no packet with a valid crc was decoded")
        print("# -> move the RF-Nano closer to the light bar and try again,")
        print("#    or fall back to pairing the bar with an arbitrary id.")
        return 1

    print("# remote id candidates (most frequent first):")
    for rid, n in sorted(ids.items(), key=lambda kv: -kv[1]):
        print(f"#   id={rid}   seen {n}x")
    best = max(ids, key=ids.get)
    print(f"\n# use it with:  python tools/lightbar.py --id {best} on")
    return 0


def send_line(s: serial.Serial, text: str, wait: float) -> None:
    s.reset_input_buffer()
    s.write((text + "\n").encode())
    time.sleep(wait)
    out = s.read(4096).decode("utf-8", "replace")
    for line in out.splitlines():
        if line.strip() and line.strip() != "READY":
            print(line.strip())


PA_LEVELS = {"min": 0, "low": 1, "high": 2, "max": 3}


def cmd_pair(args) -> int:
    """Spam `reset` so the bar adopts our id during its 20 s pairing window.

    Unplug the light bar and plug it back in while this is running: the bar
    learns the id of the first valid reset packet it sees after power-up and
    flashes briefly to confirm.

    With --seconds 0 it broadcasts until the process is killed, so there is no
    deadline to race against.
    """
    forever = args.seconds <= 0
    with open_port(args.port, args.baud, reset=args.reset) as s:
        settle(s)
        send_line(s, f"i {args.id}", 0.3)
        if args.pa:
            send_line(s, f"k {PA_LEVELS[args.pa]}", 0.3)
        if args.channels is not None:
            send_line(s, f"a {args.channels}", 0.2)

        print(f"# pairing: broadcasting reset with id {args.id.upper()}"
              + (f", PA {args.pa.upper()}" if args.pa else ""))
        print("# >>> power-cycle the light bar whenever you are ready <<<")
        if forever:
            print("# (runs until this job is stopped)")

        deadline = None if forever else time.monotonic() + args.seconds
        bursts = 0
        while deadline is None or time.monotonic() < deadline:
            s.write(b"r\n")
            bursts += 1
            time.sleep(1.0)
            s.read(4096)  # drain, keep the buffer clear
            if bursts % 20 == 0:
                if deadline is None:
                    print(f"#   {bursts} reset bursts sent...")
                else:
                    left = int(deadline - time.monotonic())
                    print(f"#   {bursts} reset bursts sent, {left}s left...")

        print(f"# done: {bursts} reset bursts sent with id {args.id.upper()}")
        print(f"# now try:  python tools/lightbar.py --id {args.id.upper()} on")
    return 0


def cmd_send(args) -> int:
    if args.action is None:
        sys.exit("nothing to do: give an action such as on/up/down")

    with open_port(args.port, args.baud, reset=args.reset) as s:
        settle(s)

        # Set the remote id, then the optional burst size / channel options.
        send_line(s, f"i {args.id}", 0.3)
        if args.pa:
            send_line(s, f"k {PA_LEVELS[args.pa]}", 0.3)
        if args.repeats:
            send_line(s, f"n {args.repeats}", 0.2)
        if args.channels:
            send_line(s, f"a {args.channels}", 0.2)

        action = args.action
        if action in ("on", "off", "toggle"):
            send_line(s, "o", args.wait)
        elif action in ("up", "brighter", "higher"):
            send_line(s, "u", args.wait)
        elif action in ("down", "dimmer", "lower"):
            send_line(s, "d", args.wait)
        elif action in ("cool", "cooler"):
            send_line(s, "c", args.wait)
        elif action in ("warm", "warmer"):
            send_line(s, "w", args.wait)
        elif action in ("reset",):
            send_line(s, "r", args.wait)
        elif action == "brightness":
            send_line(s, f"b {args.value}", args.wait + 0.8)
        elif action == "temp":
            send_line(s, f"t {args.value}", args.wait + 0.8)
        elif action == "raw":
            send_line(s, f"x {args.value:04X}", args.wait)
        elif action == "info":
            send_line(s, "p", 0.5)
        else:
            sys.exit(f"unknown action: {action}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", default=DEFAULT_PORT, help=f"serial port (default {DEFAULT_PORT})")
    p.add_argument("--baud", type=int, default=DEFAULT_BAUD, help=f"baud rate (default {DEFAULT_BAUD})")
    p.add_argument("--id", default="01B960", help="remote id, 6 hex digits")
    p.add_argument("--repeats", type=int, help="burst repetitions per channel")
    p.add_argument("--channels", type=int, choices=[0, 1], help="1 = hop over all four channels")
    p.add_argument("--pa", choices=sorted(PA_LEVELS), help="PA level: min, low, high or max")
    p.add_argument("--reset", action="store_true", help="reset the board before talking to it")

    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("monitor", help="just stream the serial output")
    sp.set_defaults(func=cmd_monitor)

    sp = sub.add_parser("scan", help="capture the remote and print its id")
    sp.add_argument("--seconds", type=int, default=30, help="how long to listen (default 30)")
    sp.set_defaults(func=cmd_scan)

    sp = sub.add_parser("pair", help="teach the bar an arbitrary id (power-cycle it while this runs)")
    sp.add_argument("--seconds", type=int, default=90,
                    help="how long to broadcast; 0 = until stopped (default 90)")
    sp.add_argument("--pa", choices=sorted(PA_LEVELS), help="PA level to use while pairing")
    sp.set_defaults(func=cmd_pair)

    sp = sub.add_parser("send", help="send a command to the light bar")
    sp.add_argument(
        "action",
        choices=[
            "on", "off", "toggle", "up", "brighter", "higher", "down", "dimmer",
            "lower", "cool", "cooler", "warm", "warmer", "reset", "brightness",
            "temp", "raw", "info",
        ],
    )
    sp.add_argument("value", nargs="?", type=lambda x: int(x, 0), default=0,
                    help="value for brightness/temp (0-15) or raw (hex command code)")
    sp.add_argument("--wait", type=float, default=1.5, help="seconds to wait for a reply")
    sp.set_defaults(func=cmd_send)

    # Allow "lightbar.py on" as shorthand for "lightbar.py send on".
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] in {"on", "off", "toggle", "up", "brighter", "higher", "down",
                            "dimmer", "lower", "cool", "cooler", "warm", "warmer",
                            "reset", "brightness", "temp", "raw", "info"}:
        argv = ["send"] + argv

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
