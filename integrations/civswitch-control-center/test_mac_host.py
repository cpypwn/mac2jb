import hashlib
import json
import select
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ADAPTER = Path(__file__).with_name("mac-host.py")
VERIFY = Path(__file__).with_name("verify-source.py")
SOURCE = ROOT / "vendor" / "CivSwitch-ControlCenter" / "control_center.js"


class ControlCenterHostTests(unittest.TestCase):
    def test_upstream_source_is_pinned(self):
        subprocess.run([sys.executable, str(VERIFY)], check=True, capture_output=True)

    def test_launch_keeps_socket_open_and_writes_verified_save(self):
        saved = b"CIV7offline-fixture"
        begin = {
            "version": 1,
            "path": "save:/saves/Single/XSTRIG.Civ7Save",
            "size": len(saved),
            "chunk_size": 8,
            "expected_chunks": (len(saved) + 7) // 8,
            "policy": "read only",
        }
        finish = {"version": 1, "bytes": len(saved), "chunks": begin["expected_chunks"], "complete": True}
        ready_sent = threading.Event()
        release = threading.Event()
        errors = []
        with socket.socket() as listener, tempfile.TemporaryDirectory() as directory:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)

            def serve():
                try:
                    with listener.accept()[0] as connection:
                        connection.settimeout(5)
                        payload = bytearray()
                        while chunk := connection.recv(65536):
                            payload.extend(chunk)
                        self.assertEqual(hashlib.sha256(payload).hexdigest(), hashlib.sha256(SOURCE.read_bytes()).hexdigest())
                        connection.sendall(b'CONTROL_CENTER_READY {"mode":"fixture"}\n')
                        ready_sent.set()
                        self.assertTrue(release.wait(5))
                        lines = ["SAVE_DUMP|BEGIN|" + json.dumps(begin)]
                        for index, offset in enumerate(range(0, len(saved), 8)):
                            chunk = saved[offset : offset + 8]
                            lines.append(f"SAVE_DUMP|CHUNK|{offset:016x}|{len(chunk)}|{chunk.hex()}")
                        lines.extend(["SAVE_DUMP|END|" + json.dumps(finish), "Executed successfully"])
                        connection.sendall(("\n".join(lines) + "\n").encode())
                except Exception as error:
                    errors.append(error)
                    ready_sent.set()

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            process = subprocess.Popen(
                [sys.executable, str(ADAPTER), "launch", "127.0.0.1", directory,
                 "--port", str(listener.getsockname()[1])],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                self.assertTrue(ready_sent.wait(5))
                self.assertFalse(errors, errors)
                self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                self.assertEqual(process.stdout.readline().strip(), 'CONTROL_CENTER_READY {"mode":"fixture"}')
                self.assertIsNone(process.poll())
                release.set()
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertIn("Verified backup:", stdout)
                self.assertNotIn("SAVE_DUMP|CHUNK|", stdout)
                files = list(Path(directory).glob("*/XSTRIG.Civ7Save"))
                self.assertEqual(len(files), 1)
                self.assertEqual(files[0].read_bytes(), saved)
                metadata = json.loads((files[0].parent / "metadata.json").read_text())
                self.assertEqual(metadata["sha256"], hashlib.sha256(saved).hexdigest())
                self.assertFalse(errors, errors)
            finally:
                release.set()
                if process.poll() is None:
                    process.kill()
                    process.communicate()
                thread.join(timeout=5)

    def test_missing_ready_is_a_failure(self):
        with socket.socket() as listener, tempfile.TemporaryDirectory() as directory:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)

            def serve():
                with listener.accept()[0] as connection:
                    while connection.recv(65536):
                        pass
                    connection.sendall(b"Executed successfully\n")

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            run = subprocess.run(
                [sys.executable, str(ADAPTER), "launch", "127.0.0.1", directory,
                 "--port", str(listener.getsockname()[1])],
                capture_output=True, text=True, timeout=10,
            )
            thread.join(timeout=5)
            self.assertEqual(run.returncode, 1)
            self.assertIn("did not report ready", run.stderr)


if __name__ == "__main__":
    unittest.main()
