# Switch 2 captive portal research bench

I built this bench to learn what the Switch browser actually exposes and to give other people a way to repeat the checks. It is a small local research setup: a connectivity-test DNS/HTTP entry and a browser page with bounded tests. Results are observations, not proof of a jailbreak, firmware modification, native execution, or hardware specifications.

The page and tests have been exercised on a desktop host. The packaged revision has **not** been validated on a physical Switch 2. If you try it on hardware, record the system version, setup, exact steps, and what happened; an unsupported or blocked API is a result too.

## Takeover research update — 31 October 2026

A separate local experimental dashboard now presents a ten-stage takeover workflow with per-stage status and host reporting. The dashboard source exists; a successful end-to-end takeover has not been verified.

Source review found that the early stages attempt browser memory-corruption operations, while the later application-transition, parser, kernel, and custom-firmware stages remain pending or blocked. Some success labels are assigned without checking the claimed result, and execution can continue after a caught failure. Those labels must not be treated as evidence that a stage succeeded.

No console-run evidence was verified for this update. Browser execution, a completed takeover, and support for either Switch generation remain unverified. The local OSNX dashboard title does not change this repository's Switch 2 research-bench scope.

This is a documentation update. The published bench remains the bounded diagnostic tool described below; executable takeover code is not included. Further status updates need evidence tied to an exact revision, target system and firmware, with observed results separated from planned stages.

## What is here

- `switch2-local-browser-entry.py`: local DNS and HTTP entry for a short allowlist of connectivity-test domains. Other DNS names receive NXDOMAIN; nothing is forwarded.
- `observed-entry.py`: the same entry with optional response profiles and bounded local traffic logging.
- `serve-switch2-browser-probe.py` and the HTML/JavaScript modules: browser checks for network and input, runtime, media, fixed-size boundary cases, FontFace availability/loading, a WebKit feature inventory, and a local-font environment inventory. Nothing runs until you choose a test. The `fonts`, `webkit`, and `fontenv` modules are bounded diagnostics: they do not trigger a CVE, groom the heap, override `FontFace.prototype.then`, invalidate style during a font load, or load a crafted font.
- `tests/`: host-side server and JavaScript checks. These do not prove device behavior.

The historical probe catalog is intentionally empty in this public release; it is not a record of completed research. The tiny media files are local test fixtures.

## Try the page on your computer

You need Python 3 and a modern browser; Node.js is only needed to run the JavaScript tests. No Python packages are required.

```sh
python3 serve-switch2-browser-probe.py --bind 127.0.0.1 --port 8765 --save-reports --live
```

Open `http://127.0.0.1:8765/`, choose **Connect / run again**, and select a test. **Stop live testing** clears queued work; a small running check may finish locally. Ctrl-C stops the server. Reports and the local control token are written under `work/browser-probe/`; keep them private until you have reviewed them. The page records browser details and test results, including interface names and input counts.

## Try the entry on an isolated network

Use a network and devices you control. This project does not create a Wi-Fi hotspot or configure DHCP, and its DNS helper is not a general Internet resolver. Prepare a separate test network with an access point and an IPv4 address on the computer reachable from the client. Arrange for the client to use that address as DNS. Record existing settings so you can restore them afterwards. The example address below is a placeholder: replace it with the actual address assigned to your test computer.

In one terminal, run the page server on that address:

```sh
python3 serve-switch2-browser-probe.py --bind 192.168.50.1 --port 8765 --save-reports --live
```

In a second terminal, start the entry helper, binding DNS on port 53 and HTTP on port 80:

```sh
sudo python3 switch2-local-browser-entry.py --bind 192.168.50.1 --dns-port 53 --http-port 80 --probe-port 8765
```

Ports 53 and 80 normally require administrator privileges. Check that nothing else is using them first. The helper answers only the connectivity names listed in its source and redirects recognized HTTP requests to the page. It cannot intercept HTTPS and does not guarantee that any particular firmware will open a captive portal. On a desktop, check the helper with `dig @192.168.50.1 ctest.p01.ctest.srv.nintendo.net` and `curl -i -H 'Host: ctest.p01.ctest.srv.nintendo.net' http://192.168.50.1/`. Then connect the test device and observe its actual behavior. Stop both processes with Ctrl-C and restore the original network settings.

For the observation helper, replace the second command with `sudo python3 observed-entry.py --bind 192.168.50.1 --dns-port 53 --http-port 80 --probe-port 8765`. Its default profile is `redirect`; an optional local `profile.json` containing `{"profile":"inline"}`, `{"profile":"connectivity_ok"}`, or `{"profile":"basic_auth"}` changes the test response. The authentication profile uses the public test credentials `test / test`; it is not access control. `traffic.jsonl` includes client IP addresses and must be reviewed before sharing. Do not put the helper on an untrusted network: it is a research tool, not a production captive portal.

## Run the tests

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test-boundaries.cjs tests/test-fonts.cjs tests/test-fontenv.cjs tests/test-page-export.cjs
```

These run locally and do not contact a Switch. To share a finding, include steps and relevant redacted observations; remove IP addresses, device identifiers, tokens, and anything personal from reports. Please say whether your result came from desktop, emulator, or hardware. Contributions that clarify a result or make a test reproducible are welcome.

## Provenance and status

This is a cleaned, portable copy of the existing local research bench, prepared with assistant help. Local traffic, private reports, firmware, and unrelated project files are not included. It is an independent community research project and is not affiliated with Nintendo. No open-source license has yet been selected; see LICENSE-NOTICE.md.
