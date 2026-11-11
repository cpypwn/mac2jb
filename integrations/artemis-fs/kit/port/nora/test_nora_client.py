#!/usr/bin/env python3

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import tempfile
import threading
import unittest

import nora_client


class Handler(BaseHTTPRequestHandler):
    def reply(self, body):
        body = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def record(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.server.requests.append((self.command, self.path, body))
        return body

    def do_GET(self):
        self.record()
        self.reply("nora2hax/seedsow HTTP server\n")

    def do_POST(self):
        body = self.record()
        if body == b"error":
            self.reply("status: error\nresult: deliberate failure\n")
        elif body == b"probe-fail":
            self.reply("status: ok\noutput:\nSEEDSOW_PROBE FAIL checks=34 failures=1\n")
        elif body == b"nora-pass":
            self.reply("status: ok\noutput:\nNORA_PROBE PASS checks=24 failures=0\n")
        elif body == b"unknown-marker":
            self.reply("status: ok\noutput:\nprobe finished\n")
        else:
            self.reply("status: ok\noutput:\nSEEDSOW_PROBE PASS checks=34 failures=0\n")

    def do_PUT(self):
        self.record()
        self.reply("wrote 4 bytes to save:/diagnostic.bin\n")

    def log_message(self, format, *args):
        pass


class NoraClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.requests = []
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.client = nora_client.NoraClient("127.0.0.1", cls.server.server_port, 2)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.server.requests.clear()

    def test_status_uses_get_status(self):
        result = self.client.status()
        self.assertIn("nora2hax", result)
        self.assertEqual(self.server.requests, [("GET", "/status", b"")])

    def test_eval_file_sends_exact_lua_and_rejects_lua_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "probe.lua")
            source.write_bytes(b"print('safe')\n")
            result = self.client.eval_file(source)
            self.assertIn("status: ok", result)
            self.assertEqual(
                self.server.requests,
                [("POST", "/eval", b"print('safe')\n")],
            )
            source.write_bytes(b"error")
            with self.assertRaisesRegex(nora_client.NoraError, "deliberate failure"):
                self.client.eval_file(source)

    def test_eval_file_enforces_server_body_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "large.lua")
            source.write_bytes(b"x" * (nora_client.BODY_CAP + 1))
            with self.assertRaisesRegex(ValueError, "server limit"):
                self.client.eval_file(source)
        self.assertEqual(self.server.requests, [])

    def test_upload_uses_put_and_normalizes_save_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "local.bin")
            source.write_bytes(b"data")
            result = self.client.upload(source, "save:/diagnostic.bin")
            self.assertIn("wrote 4 bytes", result)
        self.assertEqual(
            self.server.requests,
            [("PUT", "/save?path=diagnostic.bin", b"data")],
        )

    def test_upload_rejects_unsafe_or_protected_paths_before_http(self):
        paths = (
            "", "/absolute", "../escape", "save:/../escape", "bad;name",
            "save:/core.lua", "./core.lua", "save://core.lua", "a" * 201,
        )
        for path in paths:
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    nora_client.validate_save_path(path)
        self.assertEqual(self.server.requests, [])

    def test_probe_defaults_to_seedsow_and_accepts_explicit_nora_probe(self):
        self.assertEqual(nora_client.PROBE_FILE.name, "seedsow_runtime_probe.lua")
        result = self.client.probe()
        self.assertIn("SEEDSOW_PROBE PASS", result)
        self.assertEqual(self.server.requests[0][:2], ("POST", "/eval"))
        self.assertEqual(
            self.server.requests[0][2], nora_client.PROBE_FILE.read_bytes())
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "custom.lua")
            source.write_bytes(b"nora-pass")
            result = self.client.probe(source)
            self.assertIn("NORA_PROBE PASS", result)
            for body in (b"probe-fail", b"unknown-marker"):
                source.write_bytes(body)
                with self.assertRaisesRegex(nora_client.NoraError, "runtime probe failed"):
                    self.client.probe(source)

    def test_no_save_download_or_delete_api(self):
        self.assertFalse(hasattr(self.client, "download"))
        self.assertFalse(hasattr(self.client, "delete"))

    def test_seedsow_probe_has_exact_bridge_offsets(self):
        expected = {
            "thread_impl_create": 0x13dcc4,
            "thread_impl_start": 0x13e0b4,
            "svc_exit_thread": 0x168b4c,
            "get_message_buffer_on_tls": 0x14ba80,
            "os_get_thread_id": 0x1371f0,
            "get_thread_priority": 0x1370c0,
            "svc_get_info": 0x168ca4,
            "svc_send_sync": 0x168c4c,
            "svc_send_sync_user": 0x168c54,
            "svc_wait_sync": 0x168bf4,
            "svc_close_handle": 0x168be4,
            "svc_sleep_thread": 0x168b54,
            "svc_wait_for_address": 0x168d1c,
            "svc_signal_to_address": 0x168d24,
            "wait_for_address_eq1_inf": 0x132784,
            "os_yield_thread": 0x1370f0,
            "socket_initialize": 0x14d960,
            "socket_is_initialized": 0x14d930,
            "socket_socket": 0x14d4c0,
            "socket_bind": 0x14d3b0,
            "socket_listen": 0x14d440,
            "socket_accept": 0x14d380,
            "socket_recv": 0x14d300,
            "socket_send": 0x14d350,
            "socket_close": 0x14d510,
            "socket_fcntl": 0x14d560,
            "socket_get_last_error": 0x14d820,
            "longjmp": 0x5511b4,
            "vcall8_restore": 0x3d9e54,
        }
        source = nora_client.PROBE_FILE.read_text(encoding="utf-8")
        matches = re.findall(
            r'\{ "(?:thread|ipc|timing|socket|call_native)", "([^"]+)", (0x[0-9a-f]+) \}',
            source,
        )
        actual = {name: int(value, 16) for name, value in matches}
        self.assertEqual(actual, expected)
        self.assertEqual(len(matches), len(expected))
        for nora_only in (
            "fs_singleton", "fs_proxy", "fs_session_pool", "fs_proxy_domain_id",
            "thread_impl_pop_x1_x4",
        ):
            self.assertNotIn(nora_only, source)
        self.assertIn("SEEDSOW_PROBE %s checks=%d failures=%d", source)

    def test_runtime_probes_are_bounded_and_avoid_unsafe_operations(self):
        probe_dir = Path(__file__).resolve().parent
        for name, marker in (
            ("seedsow_runtime_probe.lua", "SEEDSOW_PROBE"),
            ("runtime_probe.lua", "NORA_PROBE"),
        ):
            with self.subTest(probe=name):
                source = (probe_dir / name).read_text(encoding="utf-8")
                self.assertLessEqual(len(source.encode()), nora_client.BODY_CAP)
                for operation in (
                    "N.peek", "N.poke", "N.alloc", "N.free", "N.call_deep",
                    "N.run_chain", "N.new_emitter", "coroutine", "io.open", "os.remove",
                ):
                    self.assertNotIn(operation, source)
                self.assertIn(marker + " %s checks=%d failures=%d", source)


if __name__ == "__main__":
    unittest.main()
