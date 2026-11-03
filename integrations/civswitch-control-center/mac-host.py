import argparse
import ipaddress
import socket
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / "vendor" / "CivSwitch-ControlCenter"
sys.path.insert(0, str(UPSTREAM))
from tools.save_dump_receiver import SaveDumpReceiver


def parse_args(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("launch",))
    parser.add_argument("console_ip")
    parser.add_argument("backup_dir", type=Path)
    parser.add_argument("--port", type=int, default=9026)
    args = parser.parse_args(argv)
    try:
        if ipaddress.ip_address(args.console_ip).version != 4:
            raise ValueError("not IPv4")
    except ValueError:
        parser.error("console_ip must be an IPv4 address")
    if not args.backup_dir.is_absolute():
        parser.error("backup_dir must be an absolute path")
    if args.port < 1 or args.port > 65535:
        parser.error("port must be between 1 and 65535")
    return args


def launch(host, port, backup_dir):
    code = (UPSTREAM / "control_center.js").read_bytes()
    receiver = SaveDumpReceiver(host, port, backup_dir)
    pending = bytearray()
    ready = False
    with socket.create_connection((host, port), timeout=8) as connection:
        connection.sendall(code)
        connection.shutdown(socket.SHUT_WR)
        connection.settimeout(1800)
        while True:
            block = connection.recv(65536)
            if not block:
                break
            pending.extend(block)
            if len(pending) > 65536 and b"\n" not in pending:
                raise RuntimeError("loader response line is too long")
            while b"\n" in pending:
                raw, _, remainder = pending.partition(b"\n")
                pending = bytearray(remainder)
                line = raw.decode("utf-8", "replace").rstrip("\r")
                if line.startswith("SAVE_DUMP|"):
                    for message in receiver.handle(line):
                        print(message, flush=True)
                elif line:
                    print(line, flush=True)
                    if line.startswith("CONTROL_CENTER_READY "):
                        ready = True
    if pending.strip():
        raise RuntimeError("loader connection ended with an unterminated line")
    if receiver.active and not receiver.complete:
        raise RuntimeError("loader connection ended during save export")
    if not ready:
        raise RuntimeError("Control Center did not report ready")


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        launch(args.console_ip, args.port, args.backup_dir)
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"Control Center failed: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
