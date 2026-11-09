# USB timing and verification

The GUI persists the release gap, key hold, Enter settle, interrupt endpoint bInterval, enumeration timeout, and command waits. Changing these fields affects both bootstrap typing and command helpers. The Stock defaults button restores the original settings. Invalid saved values fall back to their individual defaults.

The selected network interface is also remembered. If that interface disappears, selection becomes empty instead of silently switching to another interface. Choose an available address explicitly to change interfaces.

## Controls

- Release gap: time after sending the key-up report.
- Key hold: time between key-down and key-up reports.
- Enter settle: additional time after Enter before the next key.
- USB bInterval: interrupt endpoint descriptor value, not milliseconds. At high speed, 6 corresponds to 4 ms and 10 to 64 ms. Actual scheduling depends on the host.
- Enumeration timeout: wait for the host to recognize the keyboard; it does not set typing speed.
- LOAD/RUN/REMOVE waits: delays between command stages, separate from editor typing.

The optional experimental fast profile selects bInterval 6, hold 10 ms, gap 5 ms and Enter settle 100 ms. It is not a reliability guarantee. Representative 25-line tests passed twice, but a subsequent 228-line transfer missed one Enter, joining two lines. A successful USB write does not prove the editor accepted the key. Full-source readback detected the mismatch even though the total character count matched.

Use the checksum tool documented in [MCP.md](MCP.md) before saving or running a newly typed bootstrap. It checks both source length and line-sensitive content. Repair mismatches or increase timing margins, then verify again. Reusing a verified saved bootstrap avoids repeating the long transfer. Keep its host profile and START argument count matched; a filename change does not convert one bootstrap ABI into another.

## Validation

Focused tests cover preference restoration and invalid values, interface disappearance/reappearance, GUI-to-helper argument plumbing, native key-down/hold/key-up ordering, endpoint intervals, and existing bootstrap/RPC/keyboard workflows. The optional MCP package separately tests stdio protocol integration and stale/unsafe session rejection. These checks do not establish filesystem access or privilege changes on a console.
