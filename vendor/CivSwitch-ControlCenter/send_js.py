#!/usr/bin/env python3
"""Launch CivSwitch Control Center through the Remote JS Loader and process
the log and save-export stream.

Usage:
  python send_js.py <console-ip> [port] file.js

The loader reads until the client half-closes, so the sender shuts down its
write side after transmission and keeps the read side open for controller
ownership, logs, and save-export frames.
"""
import socket
import sys
from pathlib import Path

from tools.save_dump_receiver import SaveDumpReceiver

TIMEOUT = 1800


def send(host, port, code):
    s = socket.create_connection((host, port), timeout=8)
    s.sendall(code.encode())
    s.shutdown(socket.SHUT_WR)
    s.settimeout(TIMEOUT)
    data = b""
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    s.close()
    return data.decode("utf-8", "replace")


def send_streaming(host, port, code, output_root):
    receiver = SaveDumpReceiver(host, port, output_root)
    receive_buffer = b""
    with socket.create_connection((host, port), timeout=8) as sock:
        sock.sendall(code.encode())
        sock.shutdown(socket.SHUT_WR)
        sock.settimeout(TIMEOUT)
        try:
            while True:
                block = sock.recv(65536)
                if not block:
                    break
                receive_buffer += block
                while b"\n" in receive_buffer:
                    raw_line, receive_buffer = receive_buffer.split(b"\n", 1)
                    line = raw_line.decode("utf-8", "replace").rstrip("\r")
                    if line.startswith("SAVE_DUMP|"):
                        for message in receiver.handle(line):
                            print(message, flush=True)
                    elif line:
                        print(line, flush=True)
        except socket.timeout:
            if receiver.active and not receiver.complete:
                raise RuntimeError("loader connection timed out during save export")
    if receive_buffer.strip():
        raise RuntimeError("loader connection ended with an unterminated line")
    if receiver.active and not receiver.complete:
        raise RuntimeError("loader connection ended during save export")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    host = args[0]
    port = 9026
    rest = args[1:]
    if rest and rest[0].isdigit():
        port = int(rest[0])
        rest = rest[1:]
    if not rest:
        print(__doc__)
        sys.exit(1)
    payload_path = Path(rest[0])
    code = payload_path.read_text(encoding="utf-8")
    output_root = Path(__file__).resolve().parent / "backups"
    send_streaming(host, port, code, output_root)


if __name__ == "__main__":
    main()
