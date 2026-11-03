import importlib.util
import socket
import struct
import threading
from http.client import HTTPConnection
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("entry", Path(__file__).resolve().parents[1] / "switch2-local-browser-entry.py")
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)

def query(name, qtype=1):
    labels = b"".join(bytes([len(x)]) + x.encode("ascii") for x in name.split(".")) + b"\0"
    return struct.pack("!HHHHHH", 42, 0x100, 1, 0, 0, 0) + labels + struct.pack("!HH", qtype, 1)

class EntryTests(unittest.TestCase):
    def test_allowlisted_name_resolves_to_local_host(self):
        answer = entry.dns_reply(query("ctest.p01.ctest.srv.nintendo.net"), "127.0.0.1")
        self.assertEqual(struct.unpack("!H", answer[6:8])[0], 1)
        self.assertEqual(answer[-4:], socket.inet_aton("127.0.0.1"))

    def test_other_names_are_not_forwarded(self):
        answer = entry.dns_reply(query("example.invalid"), "127.0.0.1")
        self.assertEqual(answer[3] & 15, 3)
        self.assertEqual(struct.unpack("!H", answer[6:8])[0], 0)

    def test_known_ipv6_query_has_no_ipv4_answer(self):
        answer = entry.dns_reply(query("ctest.p01.ctest.srv.nintendo.net", 28), "127.0.0.1")
        self.assertEqual(struct.unpack("!H", answer[6:8])[0], 0)

    def test_http_redirect_and_unrecognized_host(self):
        services = entry.bind_services("127.0.0.1", 0, 0, 8765)
        http = services[2]
        thread = threading.Thread(target=http.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        try:
            for host, expected in (("ctest.p01.ctest.srv.nintendo.net", 302), ("example.invalid", 404)):
                conn = HTTPConnection("127.0.0.1", http.server_port, timeout=2)
                conn.request("GET", "/", headers={"Host": host})
                response = conn.getresponse()
                self.assertEqual(response.status, expected)
                if expected == 302:
                    self.assertEqual(response.getheader("Location"), "http://127.0.0.1:8765/")
                response.read()
                conn.close()
        finally:
            http.shutdown()
            thread.join()
            for service in services:
                service.server_close()
