#!/usr/bin/env python3
"""Contained local DNS and HTTP entry route to the separate browser inventory."""

import argparse
import ipaddress
import os
import pwd
import socket
import socketserver
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit


HOSTS = frozenset(("ctest.p01.ctest.srv.nintendo.net", "ctest.cdn.nintendo.net", "conntest.nintendowifi.net"))
MAX_DNS = 1232


def read_name(packet, position):
    labels, seen, end = [], set(), None
    wire_size = 1
    while True:
        if position >= len(packet) or position in seen or len(seen) >= 128:
            raise ValueError("Invalid DNS name")
        seen.add(position)
        size = packet[position]
        if size & 0xC0 == 0xC0:
            if position + 1 >= len(packet):
                raise ValueError("Truncated pointer")
            pointer = ((size & 63) << 8) | packet[position + 1]
            if pointer >= len(packet):
                raise ValueError("Invalid pointer")
            if end is None:
                end = position + 2
            position = pointer
            continue
        if size & 0xC0:
            raise ValueError("Invalid label")
        position += 1
        if not size:
            return labels, position if end is None else end
        if size > 63 or position + size > len(packet):
            raise ValueError("Truncated label")
        wire_size += size + 1
        if wire_size > 255:
            raise ValueError("Name is too long")
        labels.append(packet[position:position + size])
        position += size


def dns_reply(packet, address):
    if len(packet) < 2:
        return None
    identifier = packet[:2]
    flags = struct.unpack("!H", packet[2:4])[0] if len(packet) >= 4 else 0
    if flags & 0x8000:
        return None

    def response(code, question=b"", answer=b""):
        bits = 0x8000 | (flags & 0x0100) | code
        return identifier + struct.pack("!HHHHH", bits, int(bool(question)), int(bool(answer)), 0, 0) + question + answer

    if len(packet) < 12 or len(packet) > MAX_DNS:
        return response(1)
    if flags & 0x7800:
        return response(4)
    try:
        questions, answers, authority, additional = struct.unpack("!HHHH", packet[4:12])
        if questions != 1 or answers or authority or additional > 1:
            raise ValueError("Only a single query is accepted")
        labels, end = read_name(packet, 12)
        if end + 4 > len(packet):
            raise ValueError("Missing query fields")
        query_type, query_class = struct.unpack("!HH", packet[end:end + 4])
        tail = end + 4
        if additional:
            extra_name, tail = read_name(packet, tail)
            if extra_name or tail + 10 > len(packet):
                raise ValueError("Invalid optional record")
            record_type, _, _, size = struct.unpack("!HHIH", packet[tail:tail + 10])
            if record_type != 41 or tail + 10 + size != len(packet):
                raise ValueError("Invalid optional record")
        elif tail != len(packet):
            raise ValueError("Unexpected trailing bytes")
        question = b"".join(bytes((len(label),)) + label for label in labels) + b"\0" + struct.pack("!HH", query_type, query_class)
        hostname = b".".join(labels).lower()
        known = hostname in {name.encode("ascii") for name in HOSTS} or hostname.endswith(b".savanna.srv.nintendo.net") or hostname.endswith(b".idobata.srv.nintendo.net") or hostname == b"savanna.srv.nintendo.net"
        if query_class != 1:
            return response(5, question)
        if not known:
            return response(3, question)
        if query_type != 1:
            return response(0, question)
        answer = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 0, 4) + socket.inet_aton(address)
        return response(0, question, answer)
    except (ValueError, struct.error, OSError):
        return response(1)


class QuietErrors:
    def handle_error(self, request, client_address):
        pass


class BoundedThreads(socketserver.ThreadingMixIn):
    daemon_threads = False
    block_on_close = True

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(*args, **kwargs)

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


class UDPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        packet, endpoint = self.request
        answer = dns_reply(packet, self.server.bind_ip)
        if answer is not None:
            endpoint.sendto(answer, self.client_address)


class TCPHandler(socketserver.BaseRequestHandler):
    def receive(self, size):
        result = b""
        while len(result) < size:
            chunk = self.request.recv(size - len(result))
            if not chunk:
                raise ValueError("Incomplete frame")
            result += chunk
        return result

    def handle(self):
        self.request.settimeout(2)
        try:
            size = struct.unpack("!H", self.receive(2))[0]
            if not 12 <= size <= MAX_DNS:
                return
            answer = dns_reply(self.receive(size), self.server.bind_ip)
            if answer is not None:
                self.request.sendall(struct.pack("!H", len(answer)) + answer)
        except (OSError, ValueError, struct.error):
            return


class EntryHandler(BaseHTTPRequestHandler):
    server_version = "LocalBrowserEntry/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(2)

    def log_message(self, format_string, *arguments):
        pass

    def reply(self, status, body=b"", location=None, head=False):
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        if location:
            self.send_header("Location", location)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def get_or_head(self, head=False):
        try:
            if len(self.headers.get_all("Host", [])) != 1:
                raise ValueError("One host is required")
            parsed = urlsplit("http://" + self.headers["Host"])
            if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                raise ValueError("Invalid host")
            if parsed.port not in (None, self.server.server_port):
                raise ValueError("Invalid port")
            host = (parsed.hostname or "").lower().rstrip(".")
        except ValueError:
            self.reply(400, b"Invalid host.\n", head=head)
            return
        if (host in HOSTS or host.endswith(".savanna.srv.nintendo.net") or host.endswith(".idobata.srv.nintendo.net") or host == "savanna.srv.nintendo.net") and self.path == "/":
            self.reply(302, b"Open the local feature inventory.\n", self.server.redirect_url, head)
        elif host == self.server.bind_ip and self.path == "/health":
            self.reply(200, b"Local browser entry helper ready.\n", head=head)
        else:
            self.reply(404, b"Unknown host or path.\n", head=head)

    def do_GET(self):
        self.get_or_head()

    def do_HEAD(self):
        self.get_or_head(head=True)

    def do_POST(self):
        self.reply(405, b"This helper does not accept reports or uploads.\n")


class LocalUDP(QuietErrors, socketserver.UDPServer):
    max_packet_size = MAX_DNS + 1


class LocalTCP(QuietErrors, BoundedThreads, socketserver.TCPServer):
    allow_reuse_address = True


class LocalHTTP(QuietErrors, BoundedThreads, HTTPServer):
    allow_reuse_address = True

    def server_bind(self):
        # HTTPServer's default calls getfqdn; no resolver traffic is needed here.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address


def bind_services(address, dns_port, http_port, probe_port):
    services = []
    try:
        udp = LocalUDP((address, dns_port), UDPHandler)
        services.append(udp)
        tcp = LocalTCP((address, udp.server_address[1]), TCPHandler)
        services.append(tcp)
        http = LocalHTTP((address, http_port), EntryHandler)
        services.append(http)
        for service in services:
            service.bind_ip = address
        http.redirect_url = "http://" + address + ":" + str(probe_port) + "/"
        return services
    except BaseException:
        for service in reversed(services):
            service.server_close()
        raise


def sudo_identity(environment):
    try:
        uid, gid = int(environment["SUDO_UID"]), int(environment["SUDO_GID"])
        if not (0 < uid < 2**31 and 0 < gid < 2**31) or pwd.getpwuid(uid).pw_gid != gid:
            raise ValueError("Invalid identity")
        return uid, gid
    except (KeyError, ValueError):
        raise RuntimeError("Root startup requires a valid non-root SUDO_UID and SUDO_GID.")


def drop_sudo_privileges():
    if os.geteuid() != 0:
        return
    uid, gid = sudo_identity(os.environ)
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    if os.getuid() != uid or os.geteuid() != uid or os.getegid() != gid:
        raise RuntimeError("Could not drop sudo privileges.")


def local_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
        if address.is_unspecified or not (address.is_private or address.is_loopback):
            raise ValueError("Not a local interface")
        return str(address)
    except ValueError:
        raise argparse.ArgumentTypeError("Use an explicit local IPv4 address.")


def port(value):
    try:
        number = int(value)
        if not 0 <= number <= 65535:
            raise ValueError("Invalid port")
        return number
    except ValueError:
        raise argparse.ArgumentTypeError("Use a port from 0 to 65535; 0 is for host tests only.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", type=local_ipv4, required=True)
    parser.add_argument("--dns-port", type=port, default=53)
    parser.add_argument("--http-port", type=port, default=80)
    parser.add_argument("--probe-port", type=port, default=8765)
    args = parser.parse_args()
    if not args.probe_port or args.probe_port == args.http_port:
        parser.error("The probe needs its own nonzero port.")
    services, threads = [], []
    try:
        services = bind_services(args.bind, args.dns_port, args.http_port, args.probe_port)
        drop_sudo_privileges()
        for service in services:
            thread = threading.Thread(target=service.serve_forever, kwargs={"poll_interval": 0.1})
            thread.start()
            threads.append(thread)
        print("Local helper ready; UID " + str(os.geteuid()) + ". No upstream DNS or query logs.", flush=True)
        print("DNS UDP/TCP " + args.bind + ":" + str(services[0].server_address[1]) +
              "; HTTP " + args.bind + ":" + str(services[2].server_port) +
              "; destination " + services[2].redirect_url, flush=True)
        print("Stop with Ctrl-C; restore Automatic DNS on the console afterward.", flush=True)
        while all(thread.is_alive() for thread in threads):
            threads[0].join(0.5)
    except KeyboardInterrupt:
        pass
    except (OSError, RuntimeError) as error:
        print("Could not start helper: " + str(error), file=sys.stderr)
        return 1
    finally:
        for service, thread in zip(services, threads):
            if thread.is_alive():
                service.shutdown()
        for service in reversed(services):
            service.server_close()
        for thread in threads:
            thread.join()
    return 0


if __name__ == "__main__":
    sys.exit(main())
