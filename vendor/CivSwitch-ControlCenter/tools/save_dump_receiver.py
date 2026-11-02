"""Incremental receiver for SAVE_DUMP frames emitted by CivSwitch payloads."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


class SaveDumpReceiver:
    def __init__(self, host: str, port: int, output_root: Path) -> None:
        self.host = host
        self.port = port
        self.output_root = output_root
        self.begin: dict | None = None
        self.data: bytearray | None = None
        self.seen_offsets: set[int] = set()
        self.chunks = 0
        self.active = False
        self.complete = False

    def handle(self, line: str) -> list[str]:
        parts = line.split("|", 4)
        if len(parts) < 3 or parts[0] != "SAVE_DUMP":
            return []
        kind = parts[1]
        if kind == "BEGIN":
            if self.active and not self.complete:
                raise RuntimeError("duplicate SAVE_DUMP BEGIN")
            self.begin = json.loads(parts[2])
            size = int(self.begin["size"])
            if size <= 0 or size > 128 * 1024 * 1024:
                raise RuntimeError(f"refusing implausible save size {size}")
            self.data = bytearray(size)
            self.seen_offsets.clear()
            self.chunks = 0
            self.active = True
            self.complete = False
            return [
                f"Save export started: {self.begin['path']}",
                f"  {size:,} bytes in {int(self.begin['expected_chunks']):,} chunks",
            ]

        if kind == "CHUNK":
            if not self.active or self.begin is None or self.data is None:
                raise RuntimeError("SAVE_DUMP CHUNK before BEGIN")
            if len(parts) != 5:
                raise RuntimeError("malformed SAVE_DUMP CHUNK")
            offset = int(parts[2], 16)
            length = int(parts[3])
            chunk = bytes.fromhex(parts[4])
            if len(chunk) != length:
                raise RuntimeError(f"chunk at {offset} has the wrong length")
            if offset in self.seen_offsets:
                raise RuntimeError(f"duplicate chunk offset {offset}")
            expected_offset = self.chunks * int(self.begin["chunk_size"])
            if offset != expected_offset:
                raise RuntimeError(f"out-of-order chunk at {offset}; expected {expected_offset}")
            if offset + length > len(self.data):
                raise RuntimeError(f"chunk at {offset} exceeds the declared size")
            self.data[offset : offset + length] = chunk
            self.seen_offsets.add(offset)
            self.chunks += 1
            if self.chunks % 128 == 0 or offset + length == len(self.data):
                percent = (offset + length) * 100 / len(self.data)
                return [f"  received {offset + length:,}/{len(self.data):,} bytes ({percent:.0f}%)"]
            return []

        if kind == "ERROR":
            details = json.loads(parts[2])
            raise RuntimeError(f"console save exporter failed: {details.get('message', details)}")

        if kind == "END":
            if not self.active or self.begin is None or self.data is None:
                raise RuntimeError("SAVE_DUMP END before BEGIN")
            end = json.loads(parts[2])
            if not end.get("complete"):
                raise RuntimeError("console reported an incomplete save export")
            expected_chunks = int(self.begin["expected_chunks"])
            if self.chunks != expected_chunks or self.chunks != int(end["chunks"]):
                raise RuntimeError(
                    f"chunk-count mismatch: received {self.chunks}, expected {expected_chunks}"
                )
            if len(self.data) != int(end["bytes"]):
                raise RuntimeError("save byte-count mismatch")
            if self.data[:4] != b"CIV7":
                raise RuntimeError(f"bad save magic: {bytes(self.data[:4])!r}")
            output_path, metadata_path, digest = self._write_backup(end)
            self.complete = True
            self.active = False
            return [
                f"Verified backup: {output_path}",
                f"SHA-256: {digest}",
                f"Metadata: {metadata_path}",
            ]

        return []

    def _write_backup(self, end: dict) -> tuple[Path, Path, str]:
        assert self.begin is not None and self.data is not None
        digest = hashlib.sha256(self.data).hexdigest()
        stamp = datetime.now().astimezone().strftime("%Y-%m-%d_%H%M%S%z")
        output_dir = self.output_root / stamp
        suffix = 1
        while output_dir.exists():
            output_dir = self.output_root / f"{stamp}-{suffix}"
            suffix += 1
        output_dir.mkdir(parents=True, exist_ok=False)
        output_path = output_dir / "XSTRIG.Civ7Save"
        output_path.write_bytes(self.data)
        metadata = {
            "capture_utc": datetime.now(timezone.utc).isoformat(),
            "console_host": self.host,
            "console_port": self.port,
            "source_path": self.begin["path"],
            "bytes": len(self.data),
            "chunks": self.chunks,
            "chunk_size": int(self.begin["chunk_size"]),
            "sha256": digest,
            "magic": self.data[:4].decode("ascii"),
            "transfer_complete": bool(end.get("complete")),
            "filesystem_policy": self.begin.get("policy"),
        }
        metadata_path = output_dir / "metadata.json"
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        return output_path, metadata_path, digest
