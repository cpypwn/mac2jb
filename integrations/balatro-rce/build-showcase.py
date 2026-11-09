#!/usr/bin/env python3
import hashlib
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
UPSTREAM = ROOT / "balatro-switch-rce-1.1.0.zip"
OUTPUT = ROOT / "balatro-cpypwn-showcase.zip"
UPSTREAM_SHA256 = "2c8055ec080f3c7bd7b5392f4484dbe8247efaa712563b662dfabab1b616b704"
CONSOLE = ".lovegame/bl/console.lua"
SHOWCASE = ".lovegame/bl/showcase.lua"


def main():
    if hashlib.sha256(UPSTREAM.read_bytes()).hexdigest() != UPSTREAM_SHA256:
        raise SystemExit("upstream Balatro release archive changed")
    overlay = (ROOT / "showcase.lua").read_bytes()
    with zipfile.ZipFile(UPSTREAM) as source:
        names = source.namelist()
        if len(names) != len(set(names)) or CONSOLE not in names or SHOWCASE in names:
            raise SystemExit("unexpected Balatro release archive layout")
        if any(name != ".nx_save_meta.bin" and not name.startswith(".lovegame/")
               for name in names):
            raise SystemExit("unexpected Balatro save path")
        console = source.read(CONSOLE)
        suffix = b"\nreturn M\n"
        if not console.endswith(suffix):
            raise SystemExit("Balatro console entry point changed")
        console = console[:-len(suffix)] + b'''
local ok, showcase = pcall(require, "bl.showcase")
if ok and type(showcase) == "table" and type(showcase.draw) == "function" then
    M.draw = showcase.draw
else
    log.log("[UI] showcase unavailable: " .. tostring(showcase))
end
return M
'''
        with zipfile.ZipFile(OUTPUT, "w") as target:
            for item in source.infolist():
                target.writestr(item, console if item.filename == CONSOLE else source.read(item))
            showcase_info = zipfile.ZipInfo(SHOWCASE, (1980, 1, 1, 0, 0, 0))
            showcase_info.compress_type = zipfile.ZIP_DEFLATED
            showcase_info.create_system = 3
            showcase_info.external_attr = 0o100644 << 16
            target.writestr(showcase_info, overlay)
    with zipfile.ZipFile(OUTPUT) as built, zipfile.ZipFile(UPSTREAM) as original:
        if len(built.namelist()) != len(names) + 1 or built.read(SHOWCASE) != overlay:
            raise SystemExit("Balatro showcase archive verification failed")
        if any(built.read(name) != original.read(name) for name in names if name != CONSOLE):
            raise SystemExit("unmodified Balatro release file changed")
    print(f"{OUTPUT}: {hashlib.sha256(OUTPUT.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    sys.exit(main())
