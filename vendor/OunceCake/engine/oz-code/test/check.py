"""HTTP/WebDAV conformance checks for the native server running under test/harness.c.

Usage: python3 -I check.py <port> <manifest-path>

The manifest lists every file as "<path>\t<offset>\t<size>"; file bytes are pattern(offset + i),
mirroring harness.c, so every download is verified byte-for-byte.
"""
import http.client
import socket
import sys
import threading
import urllib.parse
import xml.etree.ElementTree as ElementTree

DAV = '{DAV:}'
SLOTS = 12  # SERVER_MAX_CLIENTS in native.h; the harness deploys this many.


def pattern_bytes(offset, size):
    """Expected content of a file starting at `offset` in the fake storage (see harness.c pattern())."""
    return bytes((((o * 131) ^ (o >> 8)) & 0xff) for o in range(offset, offset + size))


def load_manifest(path):
    """Map URL path -> (offset, size)."""
    files = {}
    with open(path, encoding='utf-8', errors='surrogateescape') as handle:
        for line in handle:
            name, offset, size = line.rstrip('\n').split('\t')
            files[name] = (int(offset), int(size))
    return files


class Checker:
    """Collects pass/fail results so one run reports every failure."""

    def __init__(self, port, files):
        self.port = port
        self.files = files
        self.failures = []
        self.passed = 0

    def check(self, condition, label):
        if condition:
            self.passed += 1
        else:
            self.failures.append(label)
            print('FAIL:', label)

    def request(self, method, path, headers=None, body=None, connection=None):
        """One request; returns (status, headers dict lowercased, body)."""
        own = connection is None
        connection = connection or http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        result = (response.status, {k.lower(): v for k, v in response.getheaders()}, data)
        if own:
            connection.close()
        return result

    def file_url(self, path):
        return urllib.parse.quote(path)

    def test_options(self):
        status, headers, _ = self.request('OPTIONS', '/')
        self.check(status == 200 and headers.get('dav') == '1', 'OPTIONS advertises DAV: 1')
        self.check('PROPFIND' in headers.get('allow', ''), 'OPTIONS Allow lists PROPFIND')

    def test_full_downloads(self):
        for path, (offset, size) in self.files.items():
            status, headers, body = self.request('GET', self.file_url(path))
            self.check(status == 200 and body == pattern_bytes(offset, size), 'GET ' + path)
            self.check(headers.get('accept-ranges') == 'bytes', 'Accept-Ranges on ' + path)

    def test_ranges(self):
        offset, size = self.files['/romfs/big.bin']
        cases = [
            ('bytes=0-0', 206, 0, 1),
            ('bytes=16380-16390', 206, 16380, 11),  # Crosses a 16 KiB cache block.
            ('bytes=-10', 206, size - 10, 10),
            ('bytes=99990-', 206, 99990, size - 99990),
            ('bytes=0-999999', 206, 0, size),
            ('bytes=0-18446744073709551615', 206, 0, size),  # last + 1 would wrap.
            ('bytes=5-2', 200, 0, size),  # Invalid: ignored.
            ('bytes=0-1,5-6', 200, 0, size),  # Multiple ranges: ignored.
            ('items=0-1', 200, 0, size),
        ]
        for header, expected_status, start, length in cases:
            status, headers, body = self.request('GET', '/romfs/big.bin', {'Range': header})
            ok = status == expected_status and body == pattern_bytes(offset + start, length)
            if expected_status == 206:
                ok = ok and headers.get('content-range') == f'bytes {start}-{start + length - 1}/{size}'
            self.check(ok, f'Range {header} -> {expected_status}')
        status, headers, _ = self.request('GET', '/romfs/big.bin', {'Range': 'bytes=200000-'})
        self.check(status == 416 and headers.get('content-range') == f'bytes */{size}', 'Range past EOF -> 416')
        status, _, body = self.request('GET', '/romfs/empty.bin', {'Range': 'bytes=0-5'})
        self.check(status == 200 and body == b'', 'Range on empty file -> 200 empty')

    def test_head(self):
        status, headers, body = self.request('HEAD', '/romfs/big.bin')
        self.check(status == 200 and headers.get('content-length') == '100003' and body == b'', 'HEAD file')
        status, headers, body = self.request('HEAD', '/romfs/many/')
        self.check(status == 200 and int(headers.get('content-length', 0)) > 16384 and body == b'', 'HEAD large directory')

    def test_html_listing(self):
        status, _, body = self.request('GET', '/')
        self.check(status == 200 and b'href="http://127.0.0.1:12345/download-all.zip"' in body,
                   'root listing offers local ZIP download')
        status, headers, body = self.request('GET', '/romfs/many/')
        text = body.decode()
        self.check(status == 200 and headers.get('content-type', '').startswith('text/html'), 'directory GET is HTML')
        self.check(len(body) == int(headers['content-length']), 'listing Content-Length matches body')
        self.check(all(f'href="/romfs/many/file-{i:03d}.bin"' in text for i in range(400)), 'listing has all 400 entries')
        self.check('href="/romfs/many/deep/"' in text, 'listing links subdirectory with trailing slash')
        status, _, body = self.request('GET', '/romfs')
        text = body.decode()
        self.check('a%20b%26%3Cc%3E%27%22.dat' in text and 'a b&amp;&lt;c&gt;&#39;&quot;.dat' in text,
                   'listing escapes special names (href and text)')
        self.check('%E6%97%A5%E6%9C%AC.bin' in text, 'listing percent-encodes UTF-8')

    def propfind(self, path, depth, body=None):
        headers = {'Depth': depth} if depth is not None else {}
        if body is not None:
            headers['Content-Type'] = 'application/xml'
        return self.request('PROPFIND', path, headers, body)

    def test_propfind(self):
        status, _, body = self.propfind('/romfs/', '0')
        responses = ElementTree.fromstring(body).findall(DAV + 'response')
        self.check(status == 207 and len(responses) == 1, 'PROPFIND Depth 0 -> one response')
        self.check(responses[0].find(DAV + 'href').text == '/romfs/', 'PROPFIND Depth 0 href')

        request_body = b'<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>'
        status, _, body = self.propfind('/romfs/many', '1', request_body)
        root = ElementTree.fromstring(body)
        responses = root.findall(DAV + 'response')
        self.check(status == 207 and len(responses) == 402, 'PROPFIND Depth 1 lists self + 401 children')
        seen = {}
        for response in responses:
            href = urllib.parse.unquote(response.find(DAV + 'href').text)
            length = response.find(f'.//{DAV}getcontentlength')
            collection = response.find(f'.//{DAV}collection') is not None
            seen[href] = (collection, int(length.text) if length is not None else None)
        self.check(seen.get('/romfs/many/') == (True, None) and seen.get('/romfs/many/deep/') == (True, None),
                   'PROPFIND marks collections')
        self.check(all(seen.get(f'/romfs/many/file-{i:03d}.bin') == (False, i) for i in range(400)),
                   'PROPFIND sizes for all children')

        status, _, body = self.propfind('/romfs', '1')
        hrefs = [urllib.parse.unquote(r.find(DAV + 'href').text) for r in ElementTree.fromstring(body).findall(DAV + 'response')]
        names = [r.find(f'.//{DAV}displayname').text for r in ElementTree.fromstring(body).findall(DAV + 'response')]
        self.check('/romfs/a b&<c>\'".dat' in hrefs and 'a b&<c>\'".dat' in names, 'PROPFIND escapes special names')
        self.check('/romfs/日本.bin' in hrefs, 'PROPFIND UTF-8 href round-trips')

        status, _, _ = self.propfind('/romfs/', 'infinity')
        self.check(status == 403, 'PROPFIND Depth infinity -> 403')
        status, _, body = self.propfind('/romfs/big.bin', '1')
        self.check(status == 207 and len(ElementTree.fromstring(body).findall(DAV + 'response')) == 1,
                   'PROPFIND Depth 1 on a file -> just the file')

    def test_errors(self):
        self.check(self.request('GET', '/nope')[0] == 404, 'missing path -> 404')
        self.check(self.request('GET', '/romfs/hello.txt/x')[0] == 404, 'path under a file -> 404')
        for method in ('PUT', 'DELETE', 'LOCK', 'MKCOL', 'PROPPATCH'):
            status, headers, _ = self.request(method, '/romfs/hello.txt', body=b'')
            self.check(status == 405 and 'GET' in headers.get('allow', ''), method + ' -> 405')
        self.check(self.raw(b'GET /%zz HTTP/1.1\r\nHost: x\r\n\r\n').startswith(b'HTTP/1.1 400'), 'bad escape -> 400')
        self.check(self.raw(b'GET /%00 HTTP/1.1\r\nHost: x\r\n\r\n').startswith(b'HTTP/1.1 400'), 'encoded NUL -> 400')
        self.check(self.raw(b'garbage\r\n\r\n').startswith(b'HTTP/1.1 400'), 'garbage request -> 400')
        huge = b'GET / HTTP/1.1\r\nX: ' + b'a' * 5000 + b'\r\n\r\n'
        self.check(self.raw(huge).startswith(b'HTTP/1.1 431'), 'oversized headers -> 431')
        chunked = b'PROPFIND / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'
        self.check(self.raw(chunked).startswith(b'HTTP/1.1 501'), 'chunked request body -> 501')
        status, _, _ = self.request('GET', '/romfs/../romfs/./hello.txt')
        self.check(status == 200, 'dot segments resolve inside the tree')
        status, _, _ = self.request('GET', '/../../../etc/passwd')
        self.check(status == 404, 'dot segments cannot escape the tree')

    def raw(self, data):
        """Send raw bytes, return everything until the server closes (or 2 s of silence)."""
        with socket.create_connection(('127.0.0.1', self.port), timeout=2) as connection:
            connection.sendall(data)
            chunks = []
            try:
                while chunk := connection.recv(65536):
                    chunks.append(chunk)
            except (socket.timeout, ConnectionResetError):
                pass
            return b''.join(chunks)

    def test_keepalive_and_pipelining(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        offset, size = self.files['/romfs/hello.txt']
        ok = all(self.request('GET', '/romfs/hello.txt', connection=connection)[2] == pattern_bytes(offset, size)
                 for _ in range(20))
        # A PROPFIND with a body must not desynchronize the next request on the same connection.
        self.request('PROPFIND', '/romfs/', {'Depth': '0'}, b'<x/>' * 100, connection=connection)
        ok = ok and self.request('GET', '/romfs/hello.txt', connection=connection)[2] == pattern_bytes(offset, size)
        connection.close()
        self.check(ok, '20 keep-alive requests + PROPFIND body on one connection')

        pipeline = (b'GET /romfs/hello.txt HTTP/1.1\r\nHost: x\r\n\r\n'
                    b'HEAD /romfs/big.bin HTTP/1.1\r\nHost: x\r\n\r\n'
                    b'GET /romfs/hello.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        reply = self.raw(pipeline)
        self.check(reply.count(b'HTTP/1.1 200 OK') == 3 and reply.endswith(pattern_bytes(offset, size)),
                   'three pipelined requests answered in order')
        reply = self.raw(b'GET http://example/romfs/hello.txt HTTP/1.0\r\n\r\n')
        self.check(reply.startswith(b'HTTP/1.1 200') and b'Connection: close' in reply, 'absolute-form + HTTP/1.0 closes')

    def test_concurrency(self):
        offset, size = self.files['/romfs/big.bin']
        results = []

        def fetch():
            try:
                status, _, body = self.request('GET', '/romfs/big.bin')
                results.append(status == 200 and body == pattern_bytes(offset, size))
            except Exception as error:  # Surface as a failure, not a crash.
                results.append(repr(error))

        threads = [threading.Thread(target=fetch) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.check(results == [True] * 4, f'4 concurrent big downloads ({results})')

    def test_slot_pressure(self):
        """Idle keep-alive connections filling every slot must yield to a new client."""
        idle = [http.client.HTTPConnection('127.0.0.1', self.port, timeout=10) for _ in range(SLOTS)]
        for connection in idle:
            self.request('HEAD', '/romfs/hello.txt', connection=connection)
        status, _, _ = self.request('GET', '/romfs/hello.txt')
        self.check(status == 200, f'extra client served while {SLOTS} keep-alive connections idle ({status})')
        for connection in idle:
            connection.close()


def main():
    port, manifest = int(sys.argv[1]), sys.argv[2]
    checker = Checker(port, load_manifest(manifest))
    for name in sorted(n for n in dir(checker) if n.startswith('test_')):
        getattr(checker, name)()
    print(f'{checker.passed} passed, {len(checker.failures)} failed')
    sys.exit(1 if checker.failures else 0)


if __name__ == '__main__':
    main()
