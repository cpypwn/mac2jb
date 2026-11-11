#!/usr/bin/env python3
"""Validate the pinned upstream ZIP and stage only its launcher files.

No archive member is executed. JKSV's metadata is validated but never installed.
The CLI always uses the repository's pin; tests call the same functions with
small synthetic archives instead of redistributing upstream payload files.
"""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import zipfile

MAX_ARCHIVE = 1024 * 1024
MAX_FILE = 1024 * 1024
MAX_EXPANDED = 2 * 1024 * 1024
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def checked_records(config):
    metadata = config["metadata"]
    if metadata["path"] != ".nx_save_meta.bin":
        raise ValueError("Unexpected JKSV metadata path")
    records = [(entry["path"][1:], entry) for entry in config["files"]]
    for name, entry in records:
        value = entry["path"]
        if (not value.startswith("/.lovegame/") or "\\" in value or "\0" in value
                or any(part in ("", ".", "..") for part in value[1:].split("/"))
                or str(PurePosixPath(name)) != name):
            raise ValueError("Unsafe configured payload path")
    records.append((metadata["path"], metadata))
    expected = dict(records)
    if not config["files"] or len(expected) != len(records):
        raise ValueError("Missing or duplicate configured payload path")
    for entry in expected.values():
        size = entry["size"]
        if type(size) is not int or not 0 <= size <= MAX_FILE:
            raise ValueError("Invalid or excessive expanded file size")
        if not isinstance(entry["sha256"], str) or not HEX64.fullmatch(entry["sha256"]):
            raise ValueError("Invalid file SHA-256 pin")
    if sum(entry["size"] for entry in expected.values()) > MAX_EXPANDED:
        raise ValueError("Excessive expanded archive size")
    return expected


def read_archive(archive, config):
    expected = checked_records(config)
    archive = Path(archive)
    archive_stat = archive.lstat()
    if not stat.S_ISREG(archive_stat.st_mode):
        raise ValueError("Archive must be a regular file, not a symlink")
    pin = config["upstream"]
    if type(pin["size"]) is not int or not 0 < pin["size"] <= MAX_ARCHIVE:
        raise ValueError("Invalid archive size pin")
    if archive_stat.st_size != pin["size"]:
        raise ValueError("Archive size does not match the pinned release")
    with archive.open("rb") as source:
        raw = source.read(pin["size"] + 1)
    if len(raw) != pin["size"] or sha256(raw) != pin["sha256"]:
        raise ValueError("Archive SHA-256 does not match the pinned release")

    # Validate every member before creating an output directory. zipfile checks
    # local headers and CRCs as it reads; explicit bounds precede decompression.
    payload = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
        members = zipped.infolist()
        names = [member.filename for member in members]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate ZIP entry")
        if set(names) != set(expected):
            raise ValueError("ZIP entry set differs from the pinned release")
        for member in members:
            name = member.filename
            mode = stat.S_IFMT(member.external_attr >> 16)
            if (member.orig_filename != name or member.is_dir()
                    or mode not in (0, stat.S_IFREG)
                    or "\\" in name or "\0" in name or name.startswith("/")
                    or any(part in ("", ".", "..") for part in name.split("/"))):
                raise ValueError("Unsafe ZIP entry: " + name)
            if member.flag_bits & 1:
                raise ValueError("Encrypted ZIP entry is not supported")
            if member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError("Unsupported ZIP compression")
            record = expected[name]
            if member.file_size != record["size"] or member.compress_size > MAX_ARCHIVE:
                raise ValueError("ZIP file size differs from the pin: " + name)
            data = zipped.read(member)
            if len(data) != record["size"] or sha256(data) != record["sha256"]:
                raise ValueError("ZIP file SHA-256 differs from the pin: " + name)
            if name != config["metadata"]["path"]:
                payload[name] = data
    return payload


def check_output_path(output):
    output = Path(os.path.abspath(output))
    if os.path.lexists(output):
        raise ValueError("Staging output already exists; choose a new directory")
    # The parent must already exist. No existing directory or symlink is adopted
    # as our staging area, and no symlink ancestor redirects the new files.
    for directory in reversed([output.parent, *output.parent.parents]):
        directory_stat = directory.lstat()
        if not stat.S_ISDIR(directory_stat.st_mode):
            raise ValueError("Staging parent must be a directory without symlinks")
    return output


def extract_archive(archive, output, config):
    payload = read_archive(archive, config)
    output = check_output_path(output)
    output.mkdir(mode=0o700)
    owned = output.lstat()
    try:
        files = []
        for entry in config["files"]:
            relative = entry["path"][1:]
            local = output / relative
            local.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with local.open("xb") as target:
                target.write(payload[relative])
            local.chmod(0o600)
            files.append({**entry, "local": str(local), "replace": False})
        return {"directory": str(output), "files": files}
    except BaseException:
        # Cleanup only the directory this call created, never a replacement
        # path or a preexisting output supplied by the operator.
        try:
            current = output.lstat()
            if stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                shutil.rmtree(output)
        except OSError:
            pass
        raise


def main():
    if len(sys.argv) != 3:
        raise ValueError("usage: balatro-archive.py <pinned-release.zip> <new-output-directory>")
    config_path = Path(__file__).resolve().parent.parent / "config" / "balatro-launcher.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    print(json.dumps(extract_archive(sys.argv[1], sys.argv[2], config)))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError) as error:
        print("FAILED: " + str(error), file=sys.stderr)
        sys.exit(1)
