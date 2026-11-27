#!/usr/bin/env python3
"""Generate include/macro_script.h from payload.txt.

Each non-empty line of payload.txt becomes one keystroke batch:
  press Esc, wait 800 ms, press gamepad A, wait 1200 ms, type the line,
  press Enter twice, then (between batches only) wait 0.8 s, press the
  gamepad A button, wait 1.2 s. A fixed preamble (A x5) runs first.

Typing sends one new key per report - the only way to guarantee character
order, since a HID report is an unordered *set* of pressed keys. For speed,
consecutive keys that differ and share the same Shift state are sent
back-to-back with no release in between (a character is generated on key
press, so the output order always follows the report order). A release is
only inserted where skipping it would lose a keystroke: repeated physical
keys, including Shift changes on the same key. The experimental 6-key rollover mode (USE_6KRO below) packs
up to 6 keys per report but the host may type them out of order.

Usage: payload_to_macro.py <payload.txt> <output header>
       [--layout us|jis] [--ime-off none|lang2] [--diagnostic]
       [--ime-probe MODE] [--ime-start none|grave|grave-each-line]
"""

import argparse

# --- timings (hardware-tested values; do not lower without a timing test) ---
KEY_HOLD_MS = 40
KEY_GAP_MS = 40
# Experimental: pack up to 6 keys per report (~6x faster, but the host may
# type them out of order - see module docstring). Keep False for reliable output.
USE_6KRO = False
ENTER_HOLD_MS = 40
ENTER_GAP_MS = 200
PRE_A_WAIT_MS = 800    # wait right before the A press between batches
POST_A_WAIT_MS = 1200   # wait after the batch-start and separator A presses
A_PRESS_MS = 50
PREAMBLE_A_COUNT = 5
PREAMBLE_GAP_MS = 800  # wait after each preamble A press
ESC_TO_A_WAIT_MS = 800  # wait between the Esc key and the A press at batch start

# US QWERTY printable ASCII -> (needs_shift, HID_KEY_* name)
ASCII_TO_KEY = {" ": (0, "HID_KEY_SPACE"), "\t": (0, "HID_KEY_TAB")}
for _c in "abcdefghijklmnopqrstuvwxyz":
    ASCII_TO_KEY[_c] = (0, f"HID_KEY_{_c.upper()}")
    ASCII_TO_KEY[_c.upper()] = (1, f"HID_KEY_{_c.upper()}")
for _c in "1234567890":
    ASCII_TO_KEY[_c] = (0, f"HID_KEY_{_c}")
ASCII_TO_KEY.update({
    "!": (1, "HID_KEY_1"), "@": (1, "HID_KEY_2"), "#": (1, "HID_KEY_3"),
    "$": (1, "HID_KEY_4"), "%": (1, "HID_KEY_5"), "^": (1, "HID_KEY_6"),
    "&": (1, "HID_KEY_7"), "*": (1, "HID_KEY_8"), "(": (1, "HID_KEY_9"),
    ")": (1, "HID_KEY_0"),
    "-": (0, "HID_KEY_MINUS"), "_": (1, "HID_KEY_MINUS"),
    "=": (0, "HID_KEY_EQUAL"), "+": (1, "HID_KEY_EQUAL"),
    "[": (0, "HID_KEY_BRACKET_LEFT"), "{": (1, "HID_KEY_BRACKET_LEFT"),
    "]": (0, "HID_KEY_BRACKET_RIGHT"), "}": (1, "HID_KEY_BRACKET_RIGHT"),
    "\\": (0, "HID_KEY_BACKSLASH"), "|": (1, "HID_KEY_BACKSLASH"),
    ";": (0, "HID_KEY_SEMICOLON"), ":": (1, "HID_KEY_SEMICOLON"),
    "'": (0, "HID_KEY_APOSTROPHE"), '"': (1, "HID_KEY_APOSTROPHE"),
    "`": (0, "HID_KEY_GRAVE"), "~": (1, "HID_KEY_GRAVE"),
    ",": (0, "HID_KEY_COMMA"), "<": (1, "HID_KEY_COMMA"),
    ".": (0, "HID_KEY_PERIOD"), ">": (1, "HID_KEY_PERIOD"),
    "/": (0, "HID_KEY_SLASH"), "?": (1, "HID_KEY_SLASH"),
})

# JIS host layout, not the language of the console UI. TinyUSB calls the
# International1/3 usages KANJI1/3. No printable JIS character uses GRAVE.
JIS_TO_KEY = dict(ASCII_TO_KEY)
JIS_TO_KEY.update({
    '"': (1, "HID_KEY_2"), "&": (1, "HID_KEY_6"),
    "'": (1, "HID_KEY_7"), "(": (1, "HID_KEY_8"),
    ")": (1, "HID_KEY_9"), "=": (1, "HID_KEY_MINUS"),
    "^": (0, "HID_KEY_EQUAL"), "~": (1, "HID_KEY_EQUAL"),
    "@": (0, "HID_KEY_BRACKET_LEFT"), "`": (1, "HID_KEY_BRACKET_LEFT"),
    "[": (0, "HID_KEY_BRACKET_RIGHT"), "{": (1, "HID_KEY_BRACKET_RIGHT"),
    "]": (0, "HID_KEY_EUROPE_1"), "}": (1, "HID_KEY_EUROPE_1"),
    "+": (1, "HID_KEY_SEMICOLON"), ":": (0, "HID_KEY_APOSTROPHE"),
    "*": (1, "HID_KEY_APOSTROPHE"), "\\": (0, "HID_KEY_KANJI1"),
    "_": (1, "HID_KEY_KANJI1"), "|": (1, "HID_KEY_KANJI3"),
})
LAYOUTS = {"us": ASCII_TO_KEY, "jis": JIS_TO_KEY}
# Plain text only: no gamepad, Escape, Enter or executable content.
DIAGNOSTIC_TEXT = "abc123 ` xyz @ [ ] { } : ; ' \" ^ & * ( ) - _ = + \\ | ~ end"
PROBE_TEXT = "abc123 xyz end"
IME_PROBES = ("none", "control", "lang2", "grave", "alt-grave", "shift-caps", "muhenkan")


def probe_steps(mode):
    # Explicit opt-in diagnostic only. Toggles must never run automatically
    # on each payload line. Wait for enumeration/focus before the single test.
    out = ["    WAIT(5000),"]
    if mode == "control":
        return out + ["    WAIT(1000),"]
    key, modifier = {
        "lang2": ("HID_KEY_LANG2", "0"),
        "grave": ("HID_KEY_GRAVE", "0"),
        "alt-grave": ("HID_KEY_GRAVE", "KEYBOARD_MODIFIER_LEFTALT"),
        "shift-caps": ("HID_KEY_CAPS_LOCK", "KEYBOARD_MODIFIER_LEFTSHIFT"),
        "muhenkan": ("HID_KEY_KANJI5", "0"),
    }[mode]
    if modifier != "0":
        out.append(f"    KEYS(150, {modifier}, 0, 0, 0, 0, 0, 0),")
    out.append(f"    KEYS(250, {modifier}, {key}, 0, 0, 0, 0, 0),")
    if modifier != "0":
        out.append(f"    KEYS(150, {modifier}, 0, 0, 0, 0, 0, 0),")
    return out + ["    WAIT(1000),"]


def ime_steps(mode):
    if mode == "lang2":
        # Japanese Eisu / IME OFF candidate. Host support is not guaranteed.
        return key_steps("HID_KEY_LANG2", 0, KEY_HOLD_MS, 300)
    return []


def chunk_keys(keys):
    """Pack (shift, key_name) pairs into reports of up to 6 keys.

    A report keeps a single modifier state and never repeats a keycode;
    violating either would drop keystrokes on the host.
    """
    chunks = []
    cur_shift, cur = None, []
    for shift, key_name in keys:
        names = [name for _, name in cur]
        if len(cur) >= 6 or (cur and (shift != cur_shift or key_name in names)):
            chunks.append((cur_shift, cur))
            cur = []
        cur_shift = shift
        cur.append((shift, key_name))
    if cur:
        chunks.append((cur_shift, cur))
    return chunks


def key_steps(key_name, shift, hold, gap):
    mod = "KEYBOARD_MODIFIER_LEFTSHIFT" if shift else "0"
    return [
        f"    KEYS({hold}, {mod}, {key_name}, 0, 0, 0, 0, 0),",
        f"    WAIT({gap}),",
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload_path")
    parser.add_argument("out_path")
    parser.add_argument("--layout", choices=LAYOUTS, default="us")
    parser.add_argument("--ime-off", choices=("none", "lang2"), default="none")
    parser.add_argument("--ime-probe", choices=IME_PROBES, default="none",
                        help="Diagnostic only: try one input-mode key, then letters without punctuation")
    parser.add_argument("--ime-start", choices=("none", "grave", "grave-each-line"), default="none",
                        help="JIS only: toggle after first/every field focus; requires Japanese mode at that point")
    parser.add_argument("--diagnostic", action="store_true",
                        help="Ignore payload; type a plain-text probe without submitting")
    args = parser.parse_args()
    if args.ime_probe != "none" and (not args.diagnostic or args.ime_off != "none"):
        parser.error("--ime-probe requires --diagnostic and --ime-off none")
    if args.ime_start != "none" and (args.layout != "jis" or args.ime_off != "none" or args.ime_probe != "none"):
        parser.error("--ime-start requires --layout jis, --ime-off none and --ime-probe none")
    payload_path, out_path = args.payload_path, args.out_path
    mapping = LAYOUTS[args.layout]

    if args.diagnostic:
        raw_lines = [PROBE_TEXT if args.ime_probe != "none" else DIAGNOSTIC_TEXT]
    else:
        with open(payload_path, encoding="utf-8") as f:
            raw_lines = f.read().splitlines()

    lines = []
    for n, line in enumerate(raw_lines, 1):
        if not line.strip():
            print(f"payload_to_macro: skipping empty line {n}")
            continue
        bad = [c for c in line if c not in mapping]
        if bad:
            parser.error(f"line {n}: unsupported character(s) {sorted(set(bad))}")
        if line:
            lines.append(line)

    out = [
        "// GENERATED from payload.txt by tools/payload_to_macro.py.",
        "// Do not edit by hand - edit payload.txt and rebuild instead.",
        "#ifndef macro_script_h",
        "#define macro_script_h",
        "",
        '#include "MacroEngine.h"',
        "",
        "static const MacroStep MACRO_SCRIPT[] = {",
    ]

    # Diagnostic mode runs with the text field already focused by the user.
    preamble_count = 0 if args.diagnostic else PREAMBLE_A_COUNT
    out.append(f"    // Preamble: press A {preamble_count} times")
    for i in range(preamble_count):
        out.append(f"    PAD_BTN({A_PRESS_MS}, SWITCH_USB_MASK_A),")
        out.append(f"    WAIT({PREAMBLE_GAP_MS}),")
    out.append("")

    if args.ime_probe != "none":
        out += probe_steps(args.ime_probe)

    for i, line in enumerate(lines):
        comment = line.replace("*/", "* /")
        out.append(f'    // Batch {i + 1}: type "{comment}"')
        if not args.diagnostic:
            out.append("    // Press Esc, then gamepad A")
            out.append(f"    KEYS({KEY_HOLD_MS}, 0, HID_KEY_ESCAPE, 0, 0, 0, 0, 0),")
            out.append(f"    WAIT({ESC_TO_A_WAIT_MS}),")
            out.append(f"    PAD_BTN({A_PRESS_MS}, SWITCH_USB_MASK_A),")
            out.append(f"    WAIT({POST_A_WAIT_MS}),")
        if args.ime_start == "grave-each-line" or (i == 0 and args.ime_start == "grave"):
            out.append("    // Japanese mode required here: toggle once after field focus")
            # Keep the long enumeration wait only for the first line.
            # Later fields already have the normal POST_A_WAIT_MS delay.
            out += probe_steps("grave") if i == 0 else probe_steps("grave")[1:]
        out += ime_steps(args.ime_off)
        out.append("")
        keys = [mapping[c] for c in line]
        if USE_6KRO:
            for shift, chunk in chunk_keys(keys):
                names = [name for _, name in chunk] + ["0"] * (6 - len(chunk))
                mod = "KEYBOARD_MODIFIER_LEFTSHIFT" if shift else "0"
                out.append(f"    KEYS({KEY_HOLD_MS}, {mod}, {', '.join(names)}),")
                out.append(f"    WAIT({KEY_GAP_MS}),")
        else:
            # One new key per report, back-to-back holds - no
            # gaps between keystrokes. A character is generated on key
            # press, so output order always follows report order, and each
            # report carries its own modifier byte, so Shift changes need
            # no release either. The ONLY mandatory release is between two
            # consecutive presses of the same key: without a report where
            # the key is absent, the host sees one held key, not two presses.
            prev = None
            for shift, key_name in keys:
                if prev is not None and key_name == prev[1]:
                    out.append(f"    WAIT({KEY_GAP_MS}),")
                mod = "KEYBOARD_MODIFIER_LEFTSHIFT" if shift else "0"
                out.append(f"    KEYS({KEY_HOLD_MS}, {mod}, {key_name}, 0, 0, 0, 0, 0),")
                prev = (shift, key_name)
        out.append("")
        if args.diagnostic:
            out.append(f"    WAIT({KEY_GAP_MS}),")
            continue
        out.append("    // Press Enter twice")
        out += key_steps("HID_KEY_ENTER", 0, ENTER_HOLD_MS, ENTER_GAP_MS)
        out += key_steps("HID_KEY_ENTER", 0, ENTER_HOLD_MS, 0)[:-1]  # no trailing gap
        if i < len(lines) - 1:
            out.append("")
            out.append(f"    WAIT({PRE_A_WAIT_MS}),")
            out.append(f"    PAD_BTN({A_PRESS_MS}, SWITCH_USB_MASK_A),")
            out.append(f"    WAIT({POST_A_WAIT_MS}),")
            out.append("")

    out += [
        "",
        "    END(),",
        "};",
        "",
        "#endif",
        "",
    ]

    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out))
    print(f"payload_to_macro: {len(lines)} batch(es) -> {out_path}")


if __name__ == "__main__":
    main()
