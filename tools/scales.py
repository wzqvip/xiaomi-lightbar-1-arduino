#!/usr/bin/env python3
"""Brightness and colour-temperature scales for the Xiaomi MJGJD01YL light bar.

Official endpoints (Xiaomi user manual / mi.com specs):

    Luminous flux   270 lm
    Colour temp     2700 K .. 6500 K
    CRI             Ra95
    Rated power     5 W (80 x 0.2 W LED modules)

The bar exposes 16 discrete steps (0..15) on both axes -- that is all the
remote, and therefore the radio protocol, can express. There is no app for
this model, so the only way to talk about "what step 8 means" is to map it
onto real units.

The endpoints are official. Xiaomi does **not** document how the 15 interior
steps are spaced, and the open-source implementations disagree, so all three
models are provided here:

    mix       linear in mired. Physically motivated: mixing two LED strings
              (a warm one and a cool one) linearly in drive current makes the
              reciprocal colour temperature linear, not the temperature.
              Used by ebinf/lightbar2mqtt.
    kelvin    linear in Kelvin. Simple and what the lamperez Home Assistant
              integration does (KELVIN_SCALE = (2700, 6500) -> (0, 15)).
    lamperez  piecewise linear in mired (153->15, 219->7, 370->0), from
              lamperez/mqtt/subscriber.py scale_value().

Run directly to print a comparison table:

    python tools/scales.py            # plain text
    python tools/scales.py --markdown # markdown, for the README
"""

from __future__ import annotations

import argparse

STEPS = 15
MAX_LUMENS = 270.0
MIN_KELVIN = 2700.0
MAX_KELVIN = 6500.0

# The endpoints the reference implementations actually use. They are the
# rounded mired equivalents of 6500 K and 2700 K (153.8 and 370.4).
MIRED_COOL = 153.0  # 6536 K
MIRED_WARM = 370.0  # 2703 K

MODELS = ("mix", "kelvin", "lamperez")
DEFAULT_MODEL = "mix"


def clamp_step(step: int) -> int:
    return max(0, min(STEPS, int(step)))


# --- colour temperature -----------------------------------------------------


def step_to_mired(step: int, model: str = DEFAULT_MODEL) -> float:
    """Colour temperature of a step, in mired (reciprocal megakelvin)."""
    step = clamp_step(step)

    if model == "mix":
        return MIRED_WARM + (MIRED_COOL - MIRED_WARM) * step / STEPS

    if model == "kelvin":
        kelvin = MIN_KELVIN + (MAX_KELVIN - MIN_KELVIN) * step / STEPS
        return 1e6 / kelvin

    if model == "lamperez":
        if step >= 7:
            return 153.0 + (15 - step) * 66.0 / 8.0
        return 219.0 + (7 - step) * 151.0 / 7.0

    raise ValueError(f"unknown model: {model!r}")


def step_to_kelvin(step: int, model: str = DEFAULT_MODEL) -> float:
    """Colour temperature of a step, in Kelvin."""
    return 1e6 / step_to_mired(step, model)


def kelvin_to_step(kelvin: float, model: str = DEFAULT_MODEL) -> int:
    """Nearest step for a colour temperature in Kelvin."""
    best, best_err = 0, None
    for step in range(STEPS + 1):
        err = abs(step_to_kelvin(step, model) - kelvin)
        if best_err is None or err < best_err:
            best, best_err = step, err
    return best


# --- brightness -------------------------------------------------------------


def step_to_percent(step: int) -> float:
    return clamp_step(step) / STEPS * 100.0


def step_to_lumens(step: int) -> float:
    return clamp_step(step) / STEPS * MAX_LUMENS


def lumens_to_step(lumens: float) -> int:
    best, best_err = 0, None
    for step in range(STEPS + 1):
        err = abs(step_to_lumens(step) - lumens)
        if best_err is None or err < best_err:
            best, best_err = step, err
    return best


# --- radio command codes ----------------------------------------------------
#
# There is no "set absolute value" command. The bar is moved by relative
# commands, so an absolute value takes two packets: first overshoot past the
# end of the range (a step > 15 is accepted but only applied on the *next*
# update), then move back to the wanted value.


def brightness_commands(step: int) -> tuple[int, int]:
    """The two command codes that set brightness to `step`."""
    step = clamp_step(step)
    return (0x0500 - 16, 0x0400 + step)


def color_temp_commands(step: int) -> tuple[int, int]:
    """The two command codes that set colour temperature to `step`."""
    step = clamp_step(step)
    return (0x0300 - 16, 0x0200 + step)


# --- presentation -----------------------------------------------------------


def table_rows():
    for step in range(STEPS + 1):
        temp_cmds = color_temp_commands(step)
        bright_cmds = brightness_commands(step)
        yield {
            "step": step,
            "lumens": step_to_lumens(step),
            "percent": step_to_percent(step),
            "bright_cmds": bright_cmds,
            "mix_k": step_to_kelvin(step, "mix"),
            "mix_mired": step_to_mired(step, "mix"),
            "kelvin_k": step_to_kelvin(step, "kelvin"),
            "lamperez_k": step_to_kelvin(step, "lamperez"),
            "temp_cmds": temp_cmds,
        }


def print_table(markdown: bool = False) -> None:
    rows = list(table_rows())

    if markdown:
        print("| 档位 | 亮度 % | 亮度 lm | 亮度命令 | 色温 K (mix) | mired | 色温 K (kelvin) | 色温 K (lamperez) | 色温命令 |")
        print("| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |")
    else:
        print(f"{'step':>4} {'%':>6} {'lm':>7}  {'brightness cmd':>16}  "
              f"{'mix K':>7} {'mired':>6} {'kelvin K':>9} {'lamperez K':>11}  {'temp cmd':>14}")

    for r in rows:
        b1, b2 = r["bright_cmds"]
        t1, t2 = r["temp_cmds"]
        if markdown:
            print(f"| {r['step']} | {r['percent']:.0f}% | {r['lumens']:.0f} | "
                  f"`0x{b1:04X}` → `0x{b2:04X}` | {r['mix_k']:.0f} | {r['mix_mired']:.0f} | "
                  f"{r['kelvin_k']:.0f} | {r['lamperez_k']:.0f} | "
                  f"`0x{t1:04X}` → `0x{t2:04X}` |")
        else:
            print(f"{r['step']:>4} {r['percent']:>5.0f}% {r['lumens']:>6.0f}lm  "
                  f"0x{b1:04X} -> 0x{b2:04X}  "
                  f"{r['mix_k']:>7.0f} {r['mix_mired']:>6.0f} {r['kelvin_k']:>9.0f} "
                  f"{r['lamperez_k']:>11.0f}  0x{t1:04X} -> 0x{t2:04X}")


def dump_json() -> None:
    """Machine readable table, used to cross-check the web GUI's copy."""
    import json

    rows = [
        {
            "step": r["step"],
            "lumens": round(r["lumens"], 6),
            "percent": round(r["percent"], 6),
            "mix_k": round(r["mix_k"], 6),
            "mix_mired": round(r["mix_mired"], 6),
            "kelvin_k": round(r["kelvin_k"], 6),
            "lamperez_k": round(r["lamperez_k"], 6),
            "bright_cmds": list(r["bright_cmds"]),
            "temp_cmds": list(r["temp_cmds"]),
        }
        for r in table_rows()
    ]
    print(json.dumps(rows, indent=2))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--markdown", action="store_true", help="emit a markdown table")
    p.add_argument("--json", action="store_true", help="emit JSON, for tooling")
    args = p.parse_args()

    if args.json:
        dump_json()
    else:
        print_table(args.markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
