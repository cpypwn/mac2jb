#!/usr/bin/env python3

import argparse
import hashlib
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path


MAX_ARCHIVE = 512 * 1024 * 1024
MAX_CONTENTS = 512 * 1024 * 1024
EXPECTED_ID = "io.github.cpypwn.mac2jb.demo"
EXPECTED_HEADER = bytes.fromhex("cffaedfe0c000001")


def fail(message):
    raise ValueError(message)


def metadata(plist_bytes, binary_header):
    info = plistlib.loads(plist_bytes)
    version = info.get("CFBundleShortVersionString")
    build = info.get("CFBundleVersion")
    if not isinstance(version, str) or re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version) is None:
        fail("the app needs a stable three-part version")
    if not isinstance(build, str) or re.fullmatch(r"[1-9][0-9]{0,9}", build) is None or int(build) > 2147483647:
        fail("the app build number is invalid")
    if info.get("CFBundleIdentifier") != EXPECTED_ID or info.get("CFBundleExecutable") != "mac2jb":
        fail("the app bundle does not match mac2jb")
    if info.get("MAC2JBTestBuild") is not False:
        fail("test builds cannot be published as updater releases")
    if binary_header != EXPECTED_HEADER:
        fail("the app executable is not an Apple Silicon build")
    return version


def validate_app(app):
    if app.name != "mac2jb.app" or not app.is_dir() or app.is_symlink():
        fail("the source must be a mac2jb.app bundle")
    for root, directories, files in os.walk(app, followlinks=False):
        for name in directories + files:
            entry = Path(root) / name
            if entry.is_symlink() or not (entry.is_dir() or entry.is_file()):
                fail(f"the app contains an unsupported file: {entry}")
    executable = app / "Contents/MacOS/mac2jb"
    if not os.access(executable, os.X_OK):
        fail("the app executable is missing or not executable")
    with executable.open("rb") as stream:
        header = stream.read(8)
    version = metadata((app / "Contents/Info.plist").read_bytes(), header)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    return version


def validate_archive(archive):
    if archive.stat().st_size == 0 or archive.stat().st_size > MAX_ARCHIVE:
        fail("the archive size is outside the updater limit")
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        if not entries or len(entries) > 2048:
            fail("the archive has an unsupported number of files")
        names = set()
        normalized = set()
        total = 0
        for entry in entries:
            name = entry.filename
            if (not name.startswith("mac2jb.app/") or "\\" in name or "\x00" in name
                    or "\n" in name or "\r" in name or "//" in name
                    or any(part in (".", "..") for part in name.split("/"))):
                fail(f"the archive contains an unsupported path: {name}")
            folded = unicodedata.normalize("NFC", name).rstrip("/").casefold()
            if name in names or folded in normalized:
                fail(f"the archive contains a duplicate path: {name}")
            names.add(name)
            normalized.add(folded)
            mode = (entry.external_attr >> 16) & 0o170000
            if mode not in (0, stat.S_IFREG, stat.S_IFDIR) or (mode != 0 and (mode == stat.S_IFDIR) != entry.is_dir()):
                fail(f"the archive contains an unsupported file: {name}")
            if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                fail(f"the archive contains unsupported compression: {name}")
            if max(entry.file_size, entry.compress_size, entry.header_offset) >= 0xffffffff:
                fail(f"the archive contains an unsupported large member: {name}")
            total += entry.file_size
            if total > MAX_CONTENTS:
                fail("the uncompressed app exceeds the updater limit")
        plist_name = "mac2jb.app/Contents/Info.plist"
        binary_name = "mac2jb.app/Contents/MacOS/mac2jb"
        if plist_name not in names or binary_name not in names:
            fail("the archive is missing the app metadata or executable")
        with zipped.open(binary_name) as stream:
            header = stream.read(8)
        version = metadata(zipped.read(plist_name), header)
        if zipped.testzip() is not None:
            fail("the archive has a corrupt member")
    return version


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def prepare(source, output):
    if source.is_symlink():
        fail("the source must not be a symbolic link")
    source = source.resolve()
    output.mkdir(parents=True, exist_ok=True)
    output = output.resolve()
    app_source = source.suffix == ".app"
    version = validate_app(source) if app_source else validate_archive(source)
    archive = output / f"mac2jb-v{version}-macos-arm64.zip"
    checksums = output / f"mac2jb-v{version}-sha256sums"

    if app_source:
        with tempfile.TemporaryDirectory(prefix="mac2jb-release-", dir=output) as temporary:
            staged = Path(temporary) / archive.name
            subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(source), str(staged)], check=True)
            if validate_archive(staged) != version:
                fail("the packaged app version changed")
            if archive.exists():
                if digest(archive) != digest(staged):
                    fail(f"an unlike release archive already exists: {archive}")
            else:
                staged.replace(archive)
    elif source != archive:
        if archive.exists():
            if digest(archive) != digest(source):
                fail(f"an unlike release archive already exists: {archive}")
        else:
            try:
                os.link(source, archive)
            except OSError:
                shutil.copyfile(source, archive)

    if validate_archive(archive) != version:
        fail("the release archive does not match its version")
    checksum = f"{digest(archive)}  {archive.name}\n"
    if not checksums.exists() or checksums.read_text() != checksum:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="mac2jb-sums-", dir=output, delete=False) as stream:
            staged_sums = Path(stream.name)
            stream.write(checksum)
        staged_sums.replace(checksums)
    print(f"archive: {archive}")
    print(f"checksums: {checksums}")
    print(f"sha256: {checksum.split()[0]}")


def main():
    parser = argparse.ArgumentParser(description="prepare the two macOS release assets required by the mac2jb updater")
    parser.add_argument("source", type=Path, help="an already-built mac2jb.app or its ZIP")
    parser.add_argument("output", nargs="?", type=Path, help="asset directory (defaults to the source directory)")
    args = parser.parse_args()
    if not args.source.exists() or args.source.suffix not in (".app", ".zip"):
        parser.error("source must be an existing mac2jb.app or ZIP")
    try:
        prepare(args.source, args.output or args.source.parent)
    except (OSError, ValueError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        print(f"release assets failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
