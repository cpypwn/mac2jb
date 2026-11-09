"""Generate JKSV rewrite's packed 86-byte .nx_save_meta.bin (revision 1).

Exact schema: https://github.com/J-D-K/JKSV/blob/rewrite/include/fs/SaveMetaData.hpp

The account UID is ZERO — no personal profile is embedded. This metadata is
safe to redistribute. JKSV restore wipes the target save before restoring,
which is intentional: the launcher shadows main.lua and does not need the
game's original save files.

Based on jksv_meta.py from balatro-switch-rce by Luminger.
"""
from __future__ import annotations

import struct
import time

FORMAT = "<4sBQ16sQBBHQQIqqQB"
SIZE = struct.calcsize(FORMAT)
assert SIZE == 86
APP_ID = 0x01008D9019128000  # Gravity Circuit
SAVE_SIZE = 16 * 1024 * 1024
JOURNAL_SIZE = 16 * 1024 * 1024


def encode(*, timestamp: int | None = None) -> bytes:
    """Build privacy-safe metadata without reading any backup or user config."""
    if timestamp is None:
        timestamp = int(time.time())
    data = struct.pack(FORMAT, b"JKSV", 1, APP_ID, bytes(16),
                       0, 1, 0, 0, APP_ID, timestamp, 0,
                       SAVE_SIZE, JOURNAL_SIZE, 0, 1)
    assert len(data) == SIZE
    return data


def decode(data: bytes) -> dict:
    if len(data) != SIZE:
        raise ValueError("wrong JKSV metadata size")
    (magic, revision, app, uid, system, save_type, rank, index,
     owner, stamp, flags, size, journal, commit, space) = struct.unpack(FORMAT, data)
    if magic != b"JKSV" or revision != 1:
        raise ValueError("unexpected JKSV metadata magic/revision")
    return dict(application_id=f"{app:016x}", account_uid=uid.hex(),
                data_size=size, journal_size=journal, revision=revision,
                save_type=save_type, space_id=space, owner_id=owner,
                timestamp=stamp, system_save_id=system, rank=rank,
                index=index, flags=flags, commit_id=commit)
