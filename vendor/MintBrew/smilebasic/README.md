# SmileBASIC bridge

The supported target is SmileBASIC **4.4.9** on Switch 2 **23.0.1**. Runtime
qualification checks native instruction ranges before using version-specific
addresses. A newer version is not automatically supported.

[Getting Started](../docs/GETTING_STARTED.md) covers host setup, bootstrap
confirmation, network setup and normal launches. Save `bootstrap.bas` as NS2 in
slot 0. This fork does not use a Pico and does not type the bootstrap. In Direct
mode you load NS2, run it, perform the one-shot `REMOVE` transition, and enter the
`V=START` command printed by the host. The command ends with `0,0,0,0`, so keep the
host on a trusted local network. Do not repeat that transition inside the same
application process.

`host.cjs` establishes and qualifies the native session, then exposes a tokened
loopback RPC interface for renderer/SDK tools. `connection.cjs` coordinates the
console listener and prints the manual session command. `engine/` contains
packet, call-frame and qualification machinery; `reference/` contains small
verification records. Full SDK dumps are neither distributed nor required at
runtime. The `pico-keyboard/` directory is archived legacy material and is not
started by this fork.

The host keeps private session files in a temporary directory and deletes it on
exit. These may contain memory captures, IP addresses and tokens. Set
`HB_KEEP_SESSION=1` to retain a session under ignored `runs/` for debugging. The
release package includes source and required generated assets, not those session
records. See the SDK's
[native reference](../sdk/docs/native.md) for qualified calls and worker lifetime.

This project retains attribution to the upstream
[pepsipu/ns2jb](https://gitlab.com/pepsipu/ns2jb) entry path. The application runtime,
SDK and launcher operate inside that established process; they do not promise
an arbitrary CPU application loader or universal console service access.
