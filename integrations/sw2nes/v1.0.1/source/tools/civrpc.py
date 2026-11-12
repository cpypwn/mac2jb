#!/usr/bin/env python3
"""Minimal CivHomebrew companion protocol 1 client (TCP 9027).
Usage: civrpc.py HOST OP [key=value ...]   e.g. civrpc.py 192.168.0.10 run id=sw2nes"""
import json, socket, struct, sys


def rpc(host, request, port=9027, timeout=30):
    data = json.dumps(dict(request, protocol=1)).encode()
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.sendall(struct.pack('>I', len(data)) + data)
        header = b''
        while len(header) < 4:
            chunk = s.recv(4 - len(header))
            if not chunk: raise ConnectionError('closed before response')
            header += chunk
        size = struct.unpack('>I', header)[0]; body = b''
        while len(body) < size:
            chunk = s.recv(size - len(body))
            if not chunk: raise ConnectionError('truncated response')
            body += chunk
    return json.loads(body)


if __name__ == '__main__':
    host, op = sys.argv[1], sys.argv[2]
    req = {'op': op}
    for kv in sys.argv[3:]:
        k, v = kv.split('=', 1); req[k] = v
    print(json.dumps(rpc(host, req), indent=1)[:4000])
