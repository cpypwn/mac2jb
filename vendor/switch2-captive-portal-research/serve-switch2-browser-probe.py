#!/usr/bin/env python3
"""Serve only the bounded feature probe and optional local report endpoint."""

import argparse
import base64
import hashlib
import ipaddress
import json
import os
import re
import secrets
import struct
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


PAGE = Path(__file__).resolve().with_name("switch2-browser-probe.html")
REPORT_DIRECTORY = PAGE.parent / "work" / "browser-probe" / "reports"
MAX_REPORT_BYTES = 32768
LIVE_DIRECTORY = PAGE.parent / "work" / "browser-probe"
MODULE_FILES = {
    "/switch2-probes-boundaries.js": "switch2-probes-boundaries.js",
    "/switch2-probes-runtime.js": "switch2-probes-runtime.js",
    "/switch2-probes-media.js": "switch2-probes-media.js",
    "/switch2-probes-network.js": "switch2-probes-network.js",
    "/switch2-probes-fonts.js": "switch2-probes-fonts.js",
    "/switch2-probes-webkit.js": "switch2-probes-webkit.js",
    "/switch2-probes-fontenv.js": "switch2-probes-fontenv.js",
}
TEST_NAMES = frozenset(("runtime", "media", "network", "boundaries", "fonts", "webkit", "fontenv"))
TEST_PATHS = {name: "/switch2-probes-" + name + ".js" for name in TEST_NAMES}
FIXTURE_FILES = {
    "/probe-fixtures/probe-h264.mp4": ("probe-h264.mp4", "video/mp4"),
    "/probe-fixtures/probe-vp8.webm": ("probe-vp8.webm", "video/webm"),
    "/probe-fixtures/probe-vp9.webm": ("probe-vp9.webm", "video/webm"),
}
PAGE_BUILD = 4
REPORT_KEYS = {
    "schemaVersion", "probe", "runAt", "browser", "display", "context",
    "javascript", "canvas2d", "webgl", "svgSmil", "datalist", "limitations",
}


def local_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise argparse.ArgumentTypeError("Use a local IPv4 address.")
    if not (address.is_private or address.is_loopback or address.is_unspecified):
        raise argparse.ArgumentTypeError("Use a private LAN or loopback address.")
    return str(address)


def reject_nonfinite(value):
    raise ValueError("Non-finite JSON number")


class ProbeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, save_reports=False, live=False):
        self.save_reports = save_reports
        self.live = live
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(32)
        self.sessions = {}
        self.control_token = secrets.token_hex(32)
        super().__init__(address, ProbeHandler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def new_job(self, test):
        return {"jobId": uuid.uuid4().hex, "test": test, "revision": self.module_revision(test)}

    def module_revision(self, test):
        return hashlib.sha256(PAGE.with_name(MODULE_FILES[TEST_PATHS[test]]).read_bytes()).hexdigest()

    def control_state(self):
        now = time.monotonic()
        with self.lock:
            return {"controlVersion": PAGE_BUILD, "pageBuild": PAGE_BUILD, "sessions": [{"sessionId": key, "browser": s["browser"], "pageBuild": s.get("pageBuild", 2),
                "peerAddress": s["peer"], "lastSeenSeconds": round(now - s["seen"], 2),
                "pending": s["pending"], "running": s["running"], "results": s["results"]}
                for key, s in self.sessions.items()]}


class ProbeHandler(BaseHTTPRequestHandler):
    server_version = "FeatureProbe/1"
    sys_version = ""

    def log_message(self, format_string, *arguments):
        # Do not log client addresses, user agents or arbitrary URL strings.
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def host_is_local_target(self):
        raw_host = self.headers.get("Host", "")
        try:
            parsed = urlsplit("http://" + raw_host)
            if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                return False
            if parsed.port != self.server.server_address[1]:
                return False
            actual = ipaddress.ip_address(self.connection.getsockname()[0])
            if parsed.hostname == "localhost":
                return actual.is_loopback
            return ipaddress.ip_address(parsed.hostname) == actual
        except (ValueError, TypeError):
            return False

    def respond(self, status, body, content_type="application/json; charset=utf-8", head=False, live_page=False, extra_headers=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self' 'unsafe-inline'" + (" 'unsafe-eval'" if live_page else "") + "; style-src 'unsafe-inline'; "
            "connect-src 'self' ws://" + self.headers.get("Host", "") + "; "
            "worker-src 'self' blob:; child-src 'self' blob:; img-src 'self' data: blob:; "
            "media-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def get_or_head(self, head=False):
        if not self.host_is_local_target():
            self.respond(400, {"error": "Use the server's local IP address and port."}, head=head)
            return
        if self.path in ("/", "/switch2-browser-probe.html"):
            try:
                page = PAGE.read_bytes()
            except OSError:
                self.respond(500, {"error": "Probe page is missing."}, head=head)
                return
            self.respond(200, page, "text/html; charset=utf-8", head=head, live_page=True)
        elif self.path == "/health":
            self.respond(200, {"ok": True, "reportSaving": self.server.save_reports,
                               "live": self.server.live, "version": PAGE_BUILD, "pageBuild": PAGE_BUILD}, head=head)
        elif self.path == "/research-catalog":
            try:
                data = PAGE.with_name("switch2-research-catalog.json").read_bytes()
                if len(data) > 131072:
                    raise ValueError("Catalog exceeds its limit")
                catalog = json.loads(data)
                if catalog.get("schemaVersion") != 1:
                    raise ValueError("Unknown catalog schema")
            except (OSError, ValueError, AttributeError):
                self.respond(503, {"error": "Probe library unavailable."}, head=head)
                return
            self.respond(200, catalog, head=head)
        elif self.path == "/controlVersion":
            self.respond(200, {"controlVersion": PAGE_BUILD, "pageBuild": PAGE_BUILD}, head=head)
        elif self.path.split("?", 1)[0] in MODULE_FILES:
            parsed = urlsplit(self.path)
            if parsed.fragment or (parsed.query and not re.fullmatch(r"v=[0-9a-f]{64}", parsed.query)) or ("?" in self.path and not parsed.query):
                self.respond(404, {"error": "Unknown module query."}, head=head)
                return
            try:
                data = PAGE.with_name(MODULE_FILES[parsed.path]).read_bytes()
            except OSError:
                self.respond(404, {"error": "Module not installed."}, head=head)
                return
            if parsed.query and hashlib.sha256(data).hexdigest() != parsed.query[2:]:
                self.respond(409, {"error": "Installed module changed; queue this test again."}, head=head)
                return
            self.respond(200, data, "application/javascript; charset=utf-8", head=head)
        elif self.path in FIXTURE_FILES:
            self.serve_fixture(head)
        elif self.path == "/probe-data":
            self.respond(200, {"probe": "local-echo", "value": "switch2-probe"}, head=head)
        elif self.path == "/control" and self.server.live:
            if not self.control_authorized():
                self.respond(403, {"error": "Control authentication required."}, head=head)
                return
            self.respond(200, self.server.control_state(), head=head)
        elif self.path == "/ws" and not head:
            self.websocket_echo()
        elif self.path == "/report":
            self.respond(405, {"error": "Use POST for reports."}, head=head)
        else:
            self.respond(404, {"error": "Unknown path."}, head=head)

    def do_GET(self):
        self.get_or_head()

    def do_HEAD(self):
        self.get_or_head(head=True)

    def serve_fixture(self, head):
        filename, content_type = FIXTURE_FILES[self.path]
        try:
            with (PAGE.parent / "probe-fixtures" / filename).open("rb") as stream:
                data = stream.read(65536)
        except OSError:
            self.respond(404, {"error": "Fixture not installed."}, head=head)
            return
        if not 0 < len(data) < 65536:
            self.respond(413, {"error": "Fixture exceeds its bounded size."}, head=head)
            return
        size = len(data)
        headers = {"Accept-Ranges": "bytes"}
        raw = self.headers.get("Range")
        if raw is None:
            self.respond(200, data, content_type, head=head, extra_headers=headers)
            return
        match = re.fullmatch(r"bytes=([0-9]*)-([0-9]*)", raw.strip()) if len(raw) <= 96 and len(self.headers.get_all("Range", [])) == 1 else None
        try:
            if not match or not any(match.groups()):
                raise ValueError("Invalid range")
            first, last = match.groups()
            if first:
                start = int(first)
                end = int(last) if last else size - 1
                if start >= size or end < start:
                    raise ValueError("Unsatisfiable range")
                end = min(end, size - 1)
            else:
                count = int(last)
                if count <= 0:
                    raise ValueError("Empty suffix")
                start, end = max(0, size - count), size - 1
        except ValueError:
            headers["Content-Range"] = "bytes */" + str(size)
            self.respond(416, {"error": "Only one satisfiable byte range is accepted."}, head=head, extra_headers=headers)
            return
        headers["Content-Range"] = "bytes " + str(start) + "-" + str(end) + "/" + str(size)
        self.respond(206, data[start:end + 1], content_type, head=head, extra_headers=headers)

    def do_POST(self):
        if not self.host_is_local_target():
            self.respond(400, {"error": "Invalid host."})
            return
        live_route = self.path in ("/live/hello", "/live/next", "/live/result", "/live/queue", "/live/stop", "/control")
        if live_route and not (self.server.live and self.server.save_reports):
            self.respond(404, {"error": "Live diagnostics are not enabled."})
            return
        if not live_route and (self.path != "/report" or not self.server.save_reports):
            self.respond(404, {"error": "Report saving is not enabled or path is unknown."})
            return
        expected_origin = "http://" + self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if origin is not None and origin != expected_origin:
            self.respond(403, {"error": "Reports must come from this page's origin."})
            return
        if self.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site"):
            self.respond(403, {"error": "Reports must come from this page's origin."})
            return
        if self.headers.get("Transfer-Encoding"):
            self.respond(400, {"error": "A fixed content length is required."})
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self.respond(415, {"error": "Use application/json."})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.respond(411, {"error": "A fixed content length is required."})
            return
        if length <= 0 or length > MAX_REPORT_BYTES:
            self.respond(413, {"error": "Report size must be between 1 and 32768 bytes."})
            return
        self.connection.settimeout(10)
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete body")
            report = json.loads(raw.decode("utf-8"), parse_constant=reject_nonfinite)
            if live_route:
                self.live_request(report)
                return
            if not isinstance(report, dict) or set(report) != REPORT_KEYS:
                raise ValueError("Unknown report shape")
            if report["schemaVersion"] != 1 or report["probe"] != "switch2-browser-feature-inventory":
                raise ValueError("Unknown probe")
            if not isinstance(report["browser"], dict) or set(report["browser"]) != {"userAgent", "platform"}:
                raise ValueError("Unknown browser fields")
            if not isinstance(report["browser"]["userAgent"], str) or len(report["browser"]["userAgent"]) > 2048:
                raise ValueError("Invalid user agent")
            if not isinstance(report["browser"]["platform"], str) or len(report["browser"]["platform"]) > 256:
                raise ValueError("Invalid platform")
            serialized = json.dumps(report, indent=2, ensure_ascii=True, allow_nan=False) + "\n"
        except (UnicodeError, ValueError, RecursionError, TimeoutError, OSError):
            self.respond(400, {"error": "Invalid feature report."})
            return
        try:
            REPORT_DIRECTORY.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            name = "report-" + stamp + "-" + uuid.uuid4().hex[:8] + ".json"
            with (REPORT_DIRECTORY / name).open("x", encoding="utf-8") as stream:
                stream.write(serialized)
        except (OSError, ValueError):
            self.respond(500, {"error": "Could not save report locally."})
            return
        self.respond(201, {"saved": True, "file": name})

    def control_authorized(self):
        supplied = self.headers.get("X-Control-Token", "")
        return len(supplied) == 64 and supplied.isascii() and secrets.compare_digest(supplied, self.server.control_token)

    def live_request(self, body):
        if not isinstance(body, dict):
            self.respond(400, {"error": "Expected JSON object."})
            return
        if self.path == "/control":
            if not self.control_authorized():
                self.respond(403, {"error": "Control authentication required."})
                return
            tests, session = body.get("tests"), body.get("session")
            if not isinstance(tests, list) or not 1 <= len(tests) <= 6 or any(
                    not isinstance(t, str) or t not in TEST_NAMES for t in tests):
                self.respond(400, {"error": "Only installed named tests may be queued."})
                return
            with self.server.lock:
                s = self.server.sessions.get(session) if isinstance(session, str) else None
                if s is None or s.get("stopped") or len(s["pending"]) + len(tests) > 12:
                    self.respond(409, {"error": "Unknown session or queue full."})
                    return
                jobs = [self.server.new_job(t) for t in tests]
                s["pending"].extend(jobs)
            self.respond(200, {"queued": jobs})
            return
        if self.path == "/live/hello":
            b = body.get("browser")
            page_build = body.get("pageBuild", 2)
            if type(page_build) is not int or page_build not in (2, 3, PAGE_BUILD):
                self.respond(400, {"error": "Unsupported page build."})
                return
            if not isinstance(b, dict) or set(b) != {"userAgent", "platform"} or any(
                    not isinstance(b[k], str) or len(b[k]) > limit
                    for k, limit in (("userAgent", 2048), ("platform", 256))):
                self.respond(400, {"error": "Invalid browser description."})
                return
            with self.server.lock:
                now = time.monotonic()
                self.server.sessions = {k: s for k, s in self.server.sessions.items() if now - s["seen"] < 180 and not s.get("stopped")}
                if len(self.server.sessions) >= 8:
                    self.respond(429, {"error": "Too many active pages."})
                    return
                key = secrets.token_hex(16)
                self.server.sessions[key] = {"browser": b, "pageBuild": page_build, "peer": self.client_address[0], "seen": now,
                    "pending": [] if page_build >= 4 else [self.server.new_job(t) for t in ("network", "runtime", "media")],
                    "running": None, "results": []}
            self.respond(201, {"session": key, "version": PAGE_BUILD, "pageBuild": PAGE_BUILD})
            return
        key = self.headers.get("X-Probe-Session", "")
        with self.server.lock:
            s = self.server.sessions.get(key)
            if s is None:
                self.respond(403, {"error": "Unknown live session; reconnect this page."})
                return
            if s["peer"] != self.client_address[0] or s.get("stopped"):
                self.respond(403, {"error": "Page session is stopped or belongs to another connection address."})
                return
            s["seen"] = time.monotonic()
            if self.path == "/live/queue":
                tests = body.get("tests")
                if (set(body) != {"tests"} or not isinstance(tests, list) or not 1 <= len(tests) <= len(TEST_NAMES)
                        or any(not isinstance(t, str) or t not in TEST_NAMES for t in tests)
                        or len(set(tests)) != len(tests)):
                    self.respond(400, {"error": "Choose up to %d distinct installed browser tests." % len(TEST_NAMES)})
                    return
                if s["running"] or s["pending"]:
                    self.respond(409, {"error": "Finish the current test set first."})
                    return
                jobs = [self.server.new_job(t) for t in tests]
                s["pending"].extend(jobs)
                self.respond(200, {"queued": jobs})
                return
            if self.path == "/live/stop":
                if body:
                    self.respond(400, {"error": "Stop takes an empty object."})
                    return
                if s["running"]:
                    s["results"].append({"jobId": s["running"]["jobId"], "test": s["running"]["test"], "state": "cancelled_by_page"})
                s["pending"] = []
                s["running"] = None
                s["stopped"] = True
                self.respond(200, {"stopped": True})
                return
            if self.path == "/live/next":
                if s["running"] and s["seen"] - s["running"].get("issued", 0) > 40:
                    s["results"].append({"jobId": s["running"]["jobId"], "test": s["running"]["test"], "state": "expired"})
                    s["running"] = None
                if s["running"] is None and s["pending"]:
                    s["running"] = s["pending"].pop(0)
                    s["running"]["revision"] = self.server.module_revision(s["running"]["test"])
                    s["running"]["issued"] = s["seen"]
                self.respond(200, {"job": s["running"]})
                return
            running = s["running"]
            if running is None or body.get("jobId") != running["jobId"] or body.get("test") != running["test"]:
                self.respond(409, {"error": "Result does not match the active named test."})
                return
            if s.get("pageBuild", 2) >= 3 and body.get("revision") != running.get("revision"):
                self.respond(409, {"error": "Result does not match the requested module revision."})
                return
            result = body.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("checks"), list) or len(result["checks"]) > 256:
                self.respond(400, {"error": "Invalid test result."})
                return
            states = {"passed", "failed", "supported", "unsupported", "blocked", "timeout", "not-tested"}
            for check in result["checks"]:
                if not isinstance(check, dict) or not isinstance(check.get("id"), str) or len(check["id"]) > 160 or not isinstance(check.get("status"), str) or check["status"] not in states:
                    self.respond(400, {"error": "Invalid check record."})
                    return
            envelope = {"schemaVersion": 2, "probe": "switch2-live-browser-surface",
                "receivedAt": datetime.now(timezone.utc).isoformat(), "session": key,
                "browser": s["browser"], "jobId": running["jobId"], "test": running["test"],
                "pageBuild": s.get("pageBuild", 2), "requestedModuleRevision": running.get("revision"),
                "reportedModuleRevision": body.get("revision"),
                "result": result, "clientRunAt": body.get("runAt"), "elapsedMs": body.get("elapsedMs"),
                "limitations": "Unauthenticated client observations; feature evidence, not native execution or patch coverage."}
            REPORT_DIRECTORY.mkdir(parents=True, exist_ok=True)
            name = "live-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + running["jobId"] + ".json"
            data = json.dumps(envelope, indent=2, ensure_ascii=True, allow_nan=False) + "\n"
            with (REPORT_DIRECTORY / name).open("x", encoding="utf-8") as stream:
                stream.write(data)
            s["results"].append({"jobId": running["jobId"], "test": running["test"], "state": "received",
                                 "checks": len(result["checks"]), "file": name})
            s["results"] = s["results"][-40:]
            s["running"] = None
        self.respond(201, {"saved": True, "file": name})

    def websocket_echo(self):
        # One bounded same-origin text echo; no relay, arbitrary target or persistent stream.
        if self.headers.get("Origin") != "http://" + self.headers.get("Host", ""):
            self.respond(403, {"error": "Same-origin WebSocket required."})
            return
        key = self.headers.get("Sec-WebSocket-Key", "")
        try:
            valid_key = len(base64.b64decode(key, validate=True)) == 16
        except ValueError:
            valid_key = False
        if self.headers.get("Upgrade", "").lower() != "websocket" or self.headers.get("Sec-WebSocket-Version") != "13" or not valid_key:
            self.respond(400, {"error": "Invalid WebSocket handshake."})
            return
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")
        self.protocol_version = "HTTP/1.1"
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.connection.settimeout(3)
        self.close_connection = True
        try:
            header = self.rfile.read(2)
            if len(header) != 2 or header[0] != 0x81 or not header[1] & 0x80:
                return
            length = header[1] & 0x7f
            if length > 125:
                return
            mask = self.rfile.read(4)
            payload = self.rfile.read(length)
            if len(mask) != 4 or len(payload) != length:
                return
            decoded = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
            decoded.decode("utf-8")
            self.wfile.write(bytes((0x81, length)) + decoded + b"\x88\x00")
            self.wfile.flush()
        except (OSError, UnicodeError):
            return

    def do_OPTIONS(self):
        self.respond(405, {"error": "Cross-origin access is not enabled."})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", type=local_ipv4, default="127.0.0.1", help="Local IPv4 address; 0.0.0.0 explicitly listens on all IPv4 interfaces.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--save-reports", action="store_true", help="Save user-submitted reports in work/browser-probe/reports.")
    parser.add_argument("--live", action="store_true", help="Enable only the installed named diagnostic modules and private host queue control.")
    arguments = parser.parse_args()
    if not 0 <= arguments.port <= 65535:
        parser.error("Port must be between 0 and 65535.")
    if not PAGE.is_file():
        parser.error("Keep switch2-browser-probe.html beside this script.")
    if arguments.live and not arguments.save_reports:
        parser.error("Live diagnostics require --save-reports.")
    server = ProbeHTTPServer((arguments.bind, arguments.port), arguments.save_reports, arguments.live)
    if arguments.live:
        LIVE_DIRECTORY.mkdir(parents=True, exist_ok=True)
        control_host = "127.0.0.1" if arguments.bind == "0.0.0.0" else arguments.bind
        state = {"pid": os.getpid(), "baseUrl": "http://" + control_host + ":" + str(server.server_address[1]),
                 "token": server.control_token}
        fd = os.open(str(LIVE_DIRECTORY / "live-control.json"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(state, stream)
    print("Serving feature inventory on " + arguments.bind + ":" + str(server.server_address[1]), flush=True)
    print("LAN access: use this Mac's local IPv4 address and the displayed port." if arguments.bind == "0.0.0.0" else
          "Open http://" + arguments.bind + ":" + str(server.server_address[1]) + "/", flush=True)
    print("Report saving enabled: " + str(arguments.save_reports) + ". Stop with Ctrl-C.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
