# CFW roadmap — from the confirmed UAF to custom firmware

Written after the hardware-confirmed stages: UAF, 0xB8 reclaim, arbitrary
read, `m_backing +0x30`, `CSSFontFace` leak. The write is a POC; ARW, JOP,
kernel and CFW are ahead. This is the honest order, not a wish list.

---

## Stage 1 — JS-level ARW (the next build)

The victim locator (`arw-flip.html`) finds the `Uint32Array` backing store and
reports the candidate header offsets. When the field that reads `8` (the
length) is identified, the count-write points `m_clients` at it and extends
`m_length`. Result: a typed array that reads/writes outside its allocation.

**Dependency:** the scan window (now 0x80000) must hit the allocation.

## Stage 2 — code execution (JOP)

`ENABLE_JIT 0`, `ENABLE_WEBASSEMBLY 0`, no RWX page, and every stack pivot ends
in `retab` (authenticated). So:

- no shellcode page;
- no ROP;
- the only control-flow primitive is an **unsigned indirect branch**
  (`ldr xN,[…]; br xN` / plain `blr` in a table that is not `autda`-protected).

With ARW, overwrite a function pointer in a vtable/table that is dispatched
through `br`, and arrive at a JOP chain. The engine has its own dispatchers.

## Stage 3 — applet IPC access

Once execution exists **inside** the applet, its own NPDM applies:

`bsd:a`, `fsp-srv`, `ns:vm`, `ns:web`, `ldn:m`, `lp2p:m`, `ssl`, `sfdnsres`,
`set:sys`, `hid:sys`, `caps:a`

That gives `nn::fs` and `bsd` from the exploited process — the applet's own
clients, not the system ones.

## Stage 4 — kernel / homebrew

Two independent routes, both documented in the ns2jb research:

| route | mechanism | where |
|---|---|---|
| `fs` GetEntryType | path-normalisation overflow (`/..\` → 0x301-byte temp buffer) → kernel R/W | `fs` sysmodule; the ns2jb route without SmileBASIC |
| sysmodule chain | `chat` STUN heap overflow → arbitrary free → shaping → data-only control | `chat` module (TURN gate) |

Either yields kernel read/write. That is the line between "homebrew-capable"
and "userland only".

## Stage 5 — CFW

With kernel R/W, the CFW path is the known one:

- patch the bootloader/boot2 signature checks (or the kernel's
  `svc`/`ldr` verification);
- drop a payload (`ldr:ro`, `ns`, `pm`) that persists;
- the result is Atmosphere-style: unsigned NSP/homebrew, reboot-surviving.

**Note:** the portal applet does not link `ldr:ro`; `offlineweb0` (`0x100f`)
does. So the CFW payload has to be written by something that can reach the
loader — the sysmodule route, or the `fs` kernel route.

---

## Honest dependency chain

```
UAF (done) → read (done) → ARW (stage 1) → JOP (stage 2)
            → applet IPC (stage 3) → kernel R/W (stage 4) → CFW (stage 5)
```

Stages 1–2 are the browser's own; 3 is the applet's NPDM; 4 and 5 leave the
browser entirely and enter the system-software/kernel domain, where the
`wkc3`/`chat`/`fs` research already collected the primitives.

## What is buildable now

1. `arw-flip.html` widened → stage 1 (needs one run to identify the length field)
2. the JOP target analysis — enumerate `br` dispatchers and their tables in `wkc3`
3. the applet's IPC call stubs (`fsp-srv`/`bsd` signature layout) from the NPDM map
4. the `fs` GetEntryType overflow analysis (the ns2jb kernel route)

Each is independent and can proceed in parallel; none requires the others to
be finished first.
