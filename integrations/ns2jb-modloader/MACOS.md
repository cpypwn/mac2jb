# macOS

Use Node.js 22+ and keep your compatible RPC host open after it verifies FS 4/4.
In another terminal, open the extracted `ModLoader/` folder and run:

```sh
node load.cjs
```

The loader finds active sessions through the macOS process list and nearby
`runs/` folders. Node installation paths, spaces in folders and Node options do
not require a different loader. Every discovered session must still match its
verified FS proof and live RPC identity.

To select a host run explicitly, use the directory printed by that host:

```sh
node load.cjs --run-dir '/Users/your-user/ns2jb/runs/switch2-SESSION'
```

Keep the quotes when a path contains spaces. The selected directory must belong
to the live host; copying an old run folder does not recreate its connection.

Once the installer prints READY, follow the normal README steps: stop the host
with Ctrl+C, wait for cleanup, and close the exploit app without rebooting.
