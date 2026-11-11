#!/usr/bin/env python3
"""Crash-localizing incremental driver for nora /eval.

The nora server buffers all Lua output and only returns it when the eval
finishes, so a crash mid-eval returns nothing and the faulting step is
invisible. This driver works around that: it runs the SAME step file many
times, each time with a different __STOP_AT__ bound injected, so run N
executes steps 1..N in one eval. A run that returns "status: ok" proves
steps 1..N are safe (the process survives); the first N that returns a
connection error / no ok is the step that crashed -- 1..N-1 having already
been proven safe by the previous run. One re-arm per crash, with real signal.

The step file must contain the literal token __STOP_AT__ exactly once (it is
replaced with the current bound) and should gate each numbered step on it,
e.g.  if n <= __STOP_AT__ then ... end  via a step() helper (see the .lua).

Usage:
  nora_debug.py <host> <step_file.lua> [--max N] [--start N] [--port 8080]
"""
import argparse
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

TOKEN = "__STOP_AT__"


def post_eval(base_url, body, timeout):
    """POST one eval. Returns (ok, text). ok=False on a crash-shaped failure
    (connection reset / timeout / no 'status: ok'); the HTTPError body (a clean
    Lua error with a traceback) is returned as text with ok=False too, but is
    distinguishable because it is non-empty and lacks a socket error."""
    req = urllib.request.Request(
        base_url + "/eval", data=body,
        headers={"Content-Type": "text/x-lua; charset=utf-8"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read(0x100000).decode("utf-8", "replace")
        return (text.startswith("status: ok"), text)
    except urllib.error.HTTPError as e:
        # Server answered with an error page: a clean Lua failure, not a crash.
        body = e.read(0x100000).decode("utf-8", "replace") if e.fp else ""
        return (False, f"[HTTP {e.code}] {body}")
    except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
        # No response: the process died mid-eval -> this bound crashed.
        return (None, f"[no response: {e}]")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host")
    ap.add_argument("step_file", type=Path)
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--max", type=int, default=40, help="highest step bound to try")
    ap.add_argument("--start", type=int, default=1, help="lowest step bound to try")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--settle", type=float, default=0.3, help="pause between evals (s)")
    args = ap.parse_args(argv)

    template = args.step_file.read_text(encoding="utf-8")
    if template.count(TOKEN) != 1:
        print(f"error: step file must contain {TOKEN} exactly once", file=sys.stderr)
        return 2
    base_url = f"http://{args.host}:{args.port}"

    last_ok_text = ""
    for n in range(args.start, args.max + 1):
        body = template.replace(TOKEN, str(n)).encode("utf-8")
        ok, text = post_eval(base_url, body, args.timeout)
        if ok is None:
            # Crash: no response. Steps 1..n-1 were proven safe last iteration.
            print(f"\n=== CRASH localized at STEP {n} ===")
            print(f"(steps 1..{n-1} returned cleanly; step {n} killed the process)")
            if last_ok_text:
                tail = "\n".join(last_ok_text.strip().splitlines()[-6:])
                print("last clean output:\n" + tail)
            print(f"\nRe-arm Seedsow, then rerun with --start {n} to confirm/continue.")
            return 10
        if ok is False:
            # Clean Lua error (assert/traceback): logic failure, process alive.
            print(f"\n=== Lua FAILURE at bound STEP {n} (process still alive) ===")
            print(text.strip())
            return 11
        last_ok_text = text
        # Show only the newest step marker to keep output tight.
        new = [ln for ln in text.splitlines() if ln.startswith(f"STEP {n} ")]
        print((new[0] if new else f"STEP {n} (bound ok, no marker)"))
        time.sleep(args.settle)

    print(f"\n=== ALL {args.max} steps passed, process alive ===")
    print("\n".join(last_ok_text.strip().splitlines()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
