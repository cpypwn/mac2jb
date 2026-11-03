# ns2jb - Cellenseres

Private variant of [kurumuz/ns2jb](https://gitlab.com/kurumuz/ns2jb), retaining the upstream history and attribution.

Our additions cover Windows host support, retained RPC, native IPC buffers and handle ownership, acquisition tuning, optional Pico keyboard input, and native FS process export. [Provenance](docs/PROVENANCE.md) records the source baseline.

## Requirements and use

Node.js 22 or newer; no npm dependencies. Consult the [upstream setup](https://gitlab.com/kurumuz/ns2jb/-/blob/main/README.md) for firmware, SmileBASIC and network requirements.

The upstream bootstrap/acquisition uses temporary console save files. It is not a persistent-write-free operation. Review the [console storage policy](docs/CONSOLE-ACCESS.md) before any console action.

```sh
node run.cjs --help
node run.cjs --rpc <computer-IP>
node rpc.cjs <held-run-directory> status
```

Pass the exact held run directory to [OunceCake](https://github.com/Cellenseres/OunceCake). Keep SmileBASIC and the runner open until all clients finish. The repositories do not need to be siblings. Never reuse another run's session metadata.

## Pico keyboard

Manual input is the default. For an already paired Pico, set `NS2_PICO_KEY_FILE` to the local pairing-key file or place the key in the ignored `pico/secret`, then add `--pico` to the runner command.

The WSL launcher accepts:

```sh
scripts/ns2-hold.sh <computer-IP> --windows-runner --pico <pico-IP> --pico-host <computer-IP-visible-to-Pico>
```

For the Windows runner, the pairing-key path must be Windows-readable. Stop an older runner explicitly before starting another one.

## Host checks and payload build

Run host checks with `npm test`. Local checks stay untracked. The native payload and its manifest are unchanged.

```sh
node engine/build-payload.cjs --check --zig <zig-0.15.2-executable>
```

See [validation](docs/VALIDATION.md) for the pending console checks.
