#!/usr/bin/env python3
"""Package committed sources with separate PC and SD card directories."""

import argparse
import io
from pathlib import Path
import subprocess
import tarfile
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Destination ZIP file")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    # Archive only committed files, never local mods, captures or credentials.
    archive = subprocess.check_output(["git", "archive", "--format=tar", "HEAD"], cwd=root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as sources, zipfile.ZipFile(
        args.output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as release:
        release.writestr("sd-card-root/ns2jb-modloader/contents/", b"")
        for member in sources:
            if not member.isfile():
                continue
            name = member.name
            if name.startswith("contents/") or name.endswith("/.gitkeep"):
                continue
            if name.startswith("sd-card-root/") or name in ("README.md", "LICENSE"):
                target = name
            else:
                target = f"ModLoader/{name}"
            with sources.extractfile(member) as source:
                release.writestr(target, source.read())
    print(args.output.resolve())


if __name__ == "__main__":
    main()
