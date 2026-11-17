# Windows and WSL

This candidate fixes the SD path handling bug in v0.3.4. Console paths use `/`
on every PC operating system; local PC paths retain their own format. It also
finds verified sessions in nearby `runs/` folders when process discovery is
unavailable, including Windows hosts. You can always select a session with
`--run-dir`. Automatic selection verifies live session identity, so a stale run
cannot pass merely because its old port has been reused. If several verified
sessions are active, choose one explicitly.

The path fix and session discovery have regression tests on Linux with Windows
path semantics. An actual Windows 10/WSL hardware run is still pending. The
Windows/WSL path handling runs on the PC. This 0.3.5 candidate also includes
automatic native FS relocation and the merged block-free trace correction.

## Running from WSL

Use Linux Node.js 22+ in the WSL distribution running your ns2jb host. Check:

```sh
node -p "process.platform"
node --version
```

The first command should print `linux`. Windows Node (`node.exe`) can also be
launched from a WSL terminal, so the terminal alone does not identify the Node
runtime. Use your distribution's Linux Node when the host runs there.

Keep the host open after it verifies FS 4/4. In another terminal in that same
distribution, open the extracted `ModLoader/` folder and run:

```sh
node load.cjs
```

The folder may be in the Linux filesystem or on a mounted Windows drive. If the
loader cannot discover the host, use the run folder printed by that host:

```sh
node load.cjs --run-dir '/home/your-user/ns2jb/runs/switch2-SESSION'
```

An absolute Windows path is accepted when Linux Node runs inside WSL:

```sh
node load.cjs --run-dir 'C:\Users\your-user\Downloads\ns2jb\runs\switch2-SESSION'
```

Keep the quotes. The loader asks `wslpath` to translate the path in the current
distribution; it does not assume `/mnt/c`, a drive letter, or a user name. This
selects a host run stored on a Windows drive; it does not migrate a live Windows
host into WSL. If translation fails, supply the actual Linux path instead.

## Running from PowerShell

With a compatible host running natively on Windows, use Windows Node.js 22+:

```powershell
node load.cjs --run-dir 'C:\Users\your-user\Downloads\ns2jb\runs\switch2-SESSION'
```

The host must provide the same verified RPC and native FS operations that the
loader uses. The fix does not require a particular private fork or PC user.
Native Windows hardware validation is separate from WSL validation.

Accessing a WSL run folder from Windows does not by itself expose its live IPC
connections. Node uses Windows named pipes and Unix sockets differently. Run
host and loader in the same environment unless your provider explicitly bridges
them. Copying a run folder cannot recreate its live session. See the official
[Node IPC documentation](https://nodejs.org/api/net.html#ipc-support) and
[Microsoft WSL interop documentation](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop).

## After READY

Follow the normal README steps: stop the ns2jb host with Ctrl+C, wait for its
cleanup, then close the exploit app without rebooting. Keep the SD inserted.

If installation stops, include `ModLoader/logs/` and the session's
`state/switch2-SESSION/sd-inputs/inventory.json` if it exists. The inventory is
saved before mod layout checks, so a layout failure preserves the paths that
the console actually returned.

## Maintainer checks

```sh
node tests/windows-paths.cjs
node tests/session-discovery.cjs
node tests/patch-layout.cjs
node tests/pchtxt.cjs
node tools/verify-diagnostics.cjs
```

The Windows path simulation covers the complete SD collection and preparation
flow. It is not a replacement for running the final package with an actual
Windows/WSL host and console.
