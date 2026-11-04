# Local developer tools over MCP

The optional `tools/mcp` package exposes five read-only tools to a local MCP client. It identifies the correct bootstrap and inspects existing held RPC sessions. It runs on the Mac over stdio; nothing is added to the SmileBASIC bootstrap, and it does not open a network listener.

This is an early developer interface. Tests cover protocol integration, local source checks and rejection paths. A successful live held-session check and filesystem operation must still be demonstrated on hardware; the adapter does not claim either from a passing test.

## Install and configure

Use Node.js 22 or later, from this repository:

```sh
npm ci --ignore-scripts --prefix tools/mcp
npm test --prefix tools/mcp
```

Configure your MCP client with absolute paths. The runtime root is an **extracted mac2jb session** containing `selected-host.json`, `assets/`, `source/` and `vendor/`, not the repository directory. Use canonical paths (resolve system aliases such as `/var` to `/private/var` when applicable). Replace the UUID and repository path:

```json
{
  "mcpServers": {
    "mac2jb-local": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/mac2jb/tools/mcp/server.mjs",
        "--runtime-root",
        "/Users/you/Library/Application Support/mac2jb/Sessions/SESSION-UUID",
        "--sessions-root",
        "/Users/you/Library/Application Support/mac2jb/Sessions"
      ]
    }
  }
}
```

Keep toolkit and runtime host-profile versions matched. If a new app session replaces the configured runtime, update the explicit path and restart the MCP connection. The toolkit never silently changes its source baseline or attaches to a different console session.

## Tools

| Tool | Behavior |
| --- | --- |
| `mac2jb_list_sessions` | Paginated local session metadata; no health claim. |
| `mac2jb_preflight` | Validates selected profile, pinned bootstrap SHA256, filename, START argument count and port. |
| `mac2jb_bootstrap_checksum` | Produces a Direct-mode command and expected character count/checksum for source in slot 0. Does not send the command. |
| `mac2jb_discover_held_sessions` | Existing bounded discovery and proof checks find held runs. Returns paths relative to Sessions root. |
| `mac2jb_held_status` | Rechecks the selected run's proofs, pinned source and live local endpoints. Does not claim or detach a session. |

Suggested workflow: preflight → transfer matching bootstrap into intended empty editor → checksum in Direct mode → compare **both** values → save/run using the host profile's existing flow → discover held session → status. A mismatch means text needs repair; do not treat a partial transfer as valid.

For a verified kurumuz bootstrap, save it as `NS2` and use the app's saved-bootstrap flow with its five-argument `START`. IZMYSH uses its matching `NS2I` bootstrap and nine-argument `START`; renaming a file does not change that ABI. SmileBASIC supports Favorites: see [the bootstrap helper guide](BOOTSTRAP_KIT.md) for registration and the initialization-only boundary.

The checksum uses `PRGEDIT 0` and `PRGGET$()` and changes the editor read position. It does not execute or save program code. It includes the LF returned with each line plus an explicit separator and detects accidental transfer errors, not cryptographic tampering. It covers the expected lines; inspect for unwanted extra text as well. Run it at a clear Direct prompt, never paste it into the program editor.

## Boundaries

- No automatic typing, RUN, SAVE, connection takeover, privilege escalation, arbitrary shell, raw memory or generic RPC execution.
- Live RPC checks serialize within one adapter. Host busy/proof checks remain authoritative; no failed request is replayed.
- Paths must be owned, canonical, free of symlinks and not group/world writable. The existing held-session helper additionally requires private files/directories and validates source and session identity.
- The adapter trusts the local checkout and configured runtime. It is not a security boundary against a malicious process running as the same macOS user.
- Listed sessions may be stale. Verified held status is a point-in-time result, not a promise that the next filesystem operation succeeds.
- Filesystem browsing/export is not exposed by this initial adapter. Use the app's existing workflow; future tools must use the same session owner and operation contracts, rather than compete for GUI stdin or bypass ownership checks.

See the [official SmileBASIC source-code operation reference](https://sup4.smilebasic.com/en/doku.php?id=reference:source_code_operation) and [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). This adapter reuses `scripts/rpc-attachment.cjs` and `scripts/gui-discover-rpc.cjs` validation.
