#!/usr/bin/env python3
"""Build the Gravity Circuit launcher savegame archive for a JKSV restore.

    .Gravity Circuit/main.lua       shadows the cart's main.lua
    .Gravity Circuit/gc/*.lua       exploit modules (JankFFI, RPC, FTP, ...)

JKSV metadata is generated from the documented packed struct, with a zero
account UID. No exported ZIP or personal profile needed. JKSV wipes the
existing save on restore.

Based on build.py from balatro-switch-rce by Luminger.

Usage:
  python3 build.py -o GC-v1.0.zip
"""
from __future__ import annotations

import argparse
import jksv_meta
import subprocess
import shutil
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
IDENTITY = ".Gravity Circuit"
META = ".nx_save_meta.bin"


def luajit() -> str | None:
    return shutil.which("luajit")


def syntax_check(files: list[Path]) -> None:
    lj = luajit()
    if not lj:
        print("warn: luajit not on PATH, skipping syntax checks", file=sys.stderr)
        return
    lua_files = [f for f in files if f.suffix == ".lua"]
    for f in lua_files:
        p = subprocess.run([lj, "-bl", str(f), "/dev/null"],
                           capture_output=True, text=True)
        if p.returncode != 0:
            raise SystemExit(f"syntax error in {f}:\n{p.stderr.strip()}")
    print(f"  syntax ok: {len(lua_files)} lua files")


def collect() -> dict[str, Path]:
    """savedata-relative path -> source file."""
    out = {"main.lua": SRC / "gc" / "main.lua"}
    for f in sorted((SRC / "gc").glob("*.lua")):
        out[f"gc/{f.name}"] = f
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--out", required=True, type=Path)
    args = ap.parse_args()

    files = collect()
    print(f"== collect: {len(files)} files")
    for rel, path in sorted(files.items()):
        print(f"    {rel} ({path.stat().st_size}B)")

    print("== validate")
    syntax_check(sorted(set(files.values())))

    print("== pack")
    metadata = jksv_meta.encode()
    decoded = jksv_meta.decode(metadata)
    if decoded["application_id"] != f"{jksv_meta.APP_ID:016x}":
        raise SystemExit("JKSV metadata title ID mismatch")
    if decoded["account_uid"] != "00" * 16:
        raise SystemExit("JKSV metadata contains non-zero account UID")

    entries = {META, *(f"{IDENTITY}/{n}" for n in files)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        raise SystemExit(f"refusing to overwrite {args.out}; delete it first or use a new name")

    with args.out.open("xb") as output:
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as dst:
            dst.writestr(META, metadata)
            for rel, path in files.items():
                dst.writestr(f"{IDENTITY}/{rel}", path.read_bytes())

    with zipfile.ZipFile(args.out) as check:
        if set(check.namelist()) != entries:
            raise SystemExit("packed archive has unexpected members")
        if check.read(META) != metadata:
            raise SystemExit("packed metadata was modified")
        for rel, path in files.items():
            if check.read(f"{IDENTITY}/{rel}") != path.read_bytes():
                raise SystemExit(f"packed {rel} differs from source")

    print(f"  {args.out}: {args.out.stat().st_size}B")
    print(f"  generated JKSV {len(metadata)}-byte metadata; NO account UID")
    print(f"  WARNING: JKSV restore wipes Gravity Circuit save data")
    for rel in sorted(files):
        print(f"    + {IDENTITY}/{rel}")
    print(f"    + {META}")
    print("  next: copy zip to JKSV/Gravity Circuit/ on SD card and restore")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
