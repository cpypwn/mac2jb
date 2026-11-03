#!/usr/bin/env python3
"""Upload a JavaScript payload through CivSwitch Control Center Payload Mode."""

from __future__ import annotations

import argparse
import hashlib
import json
import socket
from pathlib import Path


MAX_CHARS = 70_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host")
    parser.add_argument("payload", type=Path)
    parser.add_argument("--port", type=int, default=9026)
    parser.add_argument("--autostart", action="store_true")
    parser.add_argument("--timeout", type=float, default=1800.0)
    return parser.parse_args()


def send_once(host: str, port: int, code: str, timeout: float, live: bool = False) -> str:
    if len(code.encode("utf-8")) > 500_000:
        raise RuntimeError("staging envelope exceeds the loader's 500,000-byte limit")
    output = bytearray()
    buffer = b""
    with socket.create_connection((host, port), timeout=8.0) as sock:
        sock.sendall(code.encode("utf-8"))
        sock.shutdown(socket.SHUT_WR)
        sock.settimeout(timeout)
        while True:
            block = sock.recv(65536)
            if not block:
                break
            output.extend(block)
            if live:
                buffer += block
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    line = raw.decode("utf-8", "replace").rstrip("\r")
                    if line:
                        print(line, flush=True)
    if live and buffer.strip():
        print(buffer.decode("utf-8", "replace"), flush=True)
    return output.decode("utf-8", "replace")


def require_success(output: str, step: str) -> None:
    if "PAYLOAD_STAGE|ERROR" in output or "Error" in output:
        raise RuntimeError(f"{step} failed:\n{output}")
    if "Executed successfully" not in output:
        raise RuntimeError(f"{step} did not complete:\n{output}")


def main() -> int:
    args = parse_args()
    source = args.payload.read_text(encoding="utf-8")
    raw = source.encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()
    chunks = [source[index : index + MAX_CHARS] for index in range(0, len(source), MAX_CHARS)] or [""]
    metadata = {
        "name": args.payload.name,
        "bytes": len(raw),
        "characters": len(source),
        "chunks": len(chunks),
        "sha256": digest,
        "autostart": args.autostart,
    }

    print(f"Staging {args.payload.name}: {len(raw):,} bytes, {len(chunks)} chunks")
    print(f"SHA-256: {digest}")
    begin = (
        "(async function(){try{var s=window.__civPayloadStage;"
        "if(!s)throw new Error('Enter Control Center Payload Mode first');"
        f"s.begin({json.dumps(metadata, separators=(',', ':'))});"
        "await log('PAYLOAD_STAGE|BEGIN');}catch(e){await log('PAYLOAD_STAGE|ERROR|'+String(e.message||e));throw e;}})();"
    )
    begin_output = send_once(args.host, args.port, begin, args.timeout)
    require_success(begin_output, "payload-stage begin")

    received = 0
    for index, chunk in enumerate(chunks, 1):
        received += len(chunk.encode("utf-8"))
        progress = {
            "received": received,
            "index": index,
            "chunks": len(chunks),
        }
        envelope = (
            "(async function(){try{var s=window.__civPayloadStage;"
            "if(!s)throw new Error('Payload Mode receiver unavailable');"
            f"s.append({json.dumps(chunk)}, {json.dumps(progress, separators=(',', ':'))});"
            f"await log('PAYLOAD_STAGE|CHUNK|{index}|{len(chunks)}|{received}');"
            "}catch(e){await log('PAYLOAD_STAGE|ERROR|'+String(e.message||e));throw e;}})();"
        )
        chunk_output = send_once(args.host, args.port, envelope, args.timeout)
        require_success(chunk_output, f"payload chunk {index}")
        print(f"  sent {received:,}/{len(raw):,} bytes ({received * 100 / max(1, len(raw)):.0f}%)", flush=True)

    final_metadata = {
        "characters": len(source),
        "sha256": digest,
        "autostart": args.autostart,
    }
    ready_message = json.dumps(f"PAYLOAD_STAGE|READY|{args.payload.name}|{digest}")
    finish = (
        "(async function(){try{var s=window.__civPayloadStage;"
        "if(!s)throw new Error('Payload Mode receiver unavailable');"
        f"await log({ready_message});"
        f"var result=await s.complete({json.dumps(final_metadata, separators=(',', ':'))});"
        "await log('PAYLOAD_STAGE|RESULT|'+JSON.stringify(result));"
        "}catch(e){await log('PAYLOAD_STAGE|ERROR|'+String(e.message||e));throw e;}})();"
    )
    if args.autostart:
        print("Transfer complete; autostarting payload.", flush=True)
    else:
        print("Transfer complete; press A on the console to start or B to return.", flush=True)
    final_output = send_once(args.host, args.port, finish, args.timeout, live=True)
    if "PAYLOAD_STAGE|ERROR" in final_output:
        raise RuntimeError("staged payload failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
