#!/usr/bin/env python3
"""Small stdlib client for Artemis HTTP diagnostic endpoints."""

import argparse
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BODY_CAP = 0x7000
RESPONSE_CAP = 0x100000
DEFAULT_PORT = 8080
DEFAULT_TIMEOUT = 10.0
PROBE_FILE = Path(__file__).with_name("seedsow_runtime_probe.lua")
PROTECTED_SAVES = frozenset({
    "core.lua",
    "inject.iet",
    "inject.lua",
    "http.lua",
    "proggy.ttf",
    "save9999.dat",
    "saveg.dat",
    "system.dat",
})
SAVE_PATH_RE = re.compile(r"^[A-Za-z0-9_./-]+$")


class NoraError(RuntimeError):
    pass


def validate_save_path(path):
    if not isinstance(path, str) or not path:
        raise ValueError("save path is empty")
    if len(path) > 200:
        raise ValueError("save path is longer than 200 characters")
    name = path.removeprefix("save:/")
    if not name:
        raise ValueError("save path is empty")
    if name.startswith("/"):
        raise ValueError("save path must be relative to save:/")
    if ".." in name:
        raise ValueError("save path must not contain '..'")
    if not SAVE_PATH_RE.fullmatch(name):
        raise ValueError("save path contains unsupported characters")
    if any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError("save path contains an empty or non-canonical component")
    if name in PROTECTED_SAVES:
        raise ValueError(f"refusing to overwrite protected save file: {name}")
    return name


def read_body(path):
    with Path(path).open("rb") as source:
        body = source.read(BODY_CAP + 1)
    if len(body) > BODY_CAP:
        raise ValueError(f"request body exceeds the {BODY_CAP:#x}-byte server limit")
    return body


class NoraClient:
    def __init__(self, host, port=DEFAULT_PORT, timeout=DEFAULT_TIMEOUT):
        host = host.strip()
        if host.startswith("[") and host.endswith("]"):
            host = host[1:-1]
        if not host or "://" in host or any(c in host for c in "/?#@"):
            raise ValueError("host must be a hostname or IP address without a scheme")
        if any(c.isspace() for c in host):
            raise ValueError("host must not contain whitespace")
        if not 1 <= port <= 65535:
            raise ValueError("port must be between 1 and 65535")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        url_host = f"[{host}]" if ":" in host else host
        self.base_url = f"http://{url_host}:{port}"
        self.timeout = timeout

    @staticmethod
    def _read_response(response):
        body = response.read(RESPONSE_CAP + 1)
        if len(body) > RESPONSE_CAP:
            raise NoraError(f"response exceeds the {RESPONSE_CAP:#x}-byte client limit")
        return body

    def _request(self, method, target, body=None, content_type=None):
        headers = {}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(
            self.base_url + target, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return self._read_response(response).decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            try:
                detail = self._read_response(error).decode("utf-8", errors="replace").strip()
            finally:
                error.close()
            message = f"HTTP {error.code} {error.reason}"
            if detail:
                message += f": {detail}"
            raise NoraError(message) from error
        except urllib.error.URLError as error:
            raise NoraError(f"request failed: {error.reason}") from error

    def status(self):
        return self._request("GET", "/status")

    def eval_file(self, path):
        result = self._request(
            "POST", "/eval", read_body(path), "text/x-lua; charset=utf-8")
        if not result.startswith("status: ok\n"):
            raise NoraError("Lua eval failed:\n" + result.rstrip())
        return result

    def upload(self, local_path, save_path):
        name = validate_save_path(save_path)
        target = "/save?" + urllib.parse.urlencode({"path": name})
        return self._request(
            "PUT", target, read_body(local_path), "application/octet-stream")

    def probe(self, path=PROBE_FILE):
        result = self.eval_file(path)
        if not any(marker in result for marker in ("SEEDSOW_PROBE PASS", "NORA_PROBE PASS")):
            raise NoraError("runtime probe failed:\n" + result.rstrip())
        return result


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", help="console hostname or IP address")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="GET /status")
    eval_parser = commands.add_parser("eval", help="evaluate a local Lua file")
    eval_parser.add_argument("file", type=Path)
    upload_parser = commands.add_parser("upload", help="PUT one file to an unprotected save path")
    upload_parser.add_argument("local_file", type=Path)
    upload_parser.add_argument("save_path")
    probe_parser = commands.add_parser("probe", help="run the read-only runtime probe")
    probe_parser.add_argument("--file", type=Path, default=PROBE_FILE)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        client = NoraClient(args.host, args.port, args.timeout)
        if args.command == "status":
            result = client.status()
        elif args.command == "eval":
            result = client.eval_file(args.file)
        elif args.command == "upload":
            result = client.upload(args.local_file, args.save_path)
        else:
            result = client.probe(args.file)
    except (NoraError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(result, end="" if result.endswith("\n") else "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
