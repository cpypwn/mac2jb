# Can Mario Kart World content be redirected or replaced?

Short answer: **no, not from this console's position.** Reading, decrypting and
decoding game content works; replacing it does not, because the console checks
NCA signatures and has no layered-filesystem hook. This page gives a verdict per
route, with what each route would require and what we actually measured.

The distinction matters for planning: the asset pipeline (dump -> decode -> glTF)
lands entirely on the working side of the line, and nothing about it depends on
the options below.

## What we hold

| capability | how we have it | evidence |
| --- | --- | --- |
| A privileged `fsp-srv` filesystem root | The exploited session's root runs as `pid=1`, so it passes the save-data access check a normal application session fails with `FS 6400` | Any title's save opens, is read and is written through it (`docs/RESULTS.md`) |
| Read-only game content | `OpenDataStorageByPath` (domain command 206) with `ContentStorageId` 1 (romfs) / 6 (DLC) returns an `IFileSystem` the service only ever serves reads from | OunceCake mounts `base` + update while the FS endpoint stays live and pulls 47,393 romfs files over FTP |
| No kernel, no sysmodules | The handle lives inside the exploited process; it is not code in `fs`, `pm`, `ldr` or the kernel | We cannot install a sysmodule or patch one; the promoted root is a client-side credential, not a service patch |

That third row is the whole story. Everything below fails for the same reason:
content replacement needs something to run *before* the game's filesystem calls,
and we have no execution context there.

## Verdict per route

| # | Route | Verdict | Why |
| --- | --- | --- | --- |
| 1 | Replace files inside the installed NCA | **Blocked** | NCAs are signed and the content is served by `ncm`/`fs` from internal storage. Writing a modified NCA means invalidating its signature, and nothing on this console skips the check. We cannot even open installed content for write: the handle `OpenDataStorageByPath` returns is read-only by construction. |
| 2 | LayeredFS-style overlay (a patched `fs` that prefers SD files) | **Blocked** | This is what Atmosphere's LayeredFS does: it patches the FS sysmodule so a title's reads are redirected to `sd:/atmosphere/contents/<id>/romfs`. It needs a sysmodule patch, i.e. kernel-level code execution, which a save exploit on a retail console does not give. |
| 3 | Redirect the *game's own* content mount from our session | **Blocked** | Content mounts are opened by the game's `fsp-srv` session, not ours. Our root answers requests for *save* archives because `pid=1` passes the check; it cannot insert itself as the server for another process's session. Doing that means patching the FS service's session table - again a sysmodule patch. |
| 4 | Serve different content over the network/FTP path | **Blocked, and irrelevant** | OunceCake's FTP server runs *inside* the exploited process and only mirrors bytes out. It is an exporter, not a mount. The console never reads game content from it. |
| 5 | Patch the running game's memory (exefs) | **Blocked** | Requires debug/memory-write access to another process. The promoted root is a filesystem handle; it carries no process-memory capability. Code-signature and integrity checks apply to the game image regardless. |
| 6 | Put modified content on the microSD card | **Blocked** | There is no SD content mount to redirect to, and the retail system has no mechanism to prefer SD files over installed ones. (Separately, the game's VFS does not even expose `sd:` - see `docs/RESULTS.md`.) |
| 7 | Find a per-game override (debug flag, loose-file loader, patch directory) in MKW itself | **Not found, and not expected** | Nothing observed in the dump so far suggests a shipping loose-file loader. This would be the only route that needs no sysmodule, and it would have to come from evidence in the game, not from the exploit. |
| 8 | Write mod data into the game's save and hope it is read as content | **Not applicable** | Save data is a real read-write filesystem and is the one thing we *can* write, but it is a different mount from `romfs`. Games read assets from `romfs`; MKW has no save-backed asset channel we have seen. |

## What would have to change

Any one of these would move route 1/2/3 into "achievable":

- kernel-level code execution, so a sysmodule can be patched (`fs` for LayeredFS);
- a bootloader/CFW that patches signature checks before `pm` launches the title;
- a legitimate per-game content override in the shipped engine.

None are available here, and no amount of save-data privilege substitutes for
them. This is a property of the platform, not of our tooling.

## What this means for the asset work

Everything on the read side is unaffected and is where the value is:

1. mount MKW's `romfs` through the same content path OunceCake uses;
2. pull the model/texture/DLC trees;
3. triage the formats (BFRES/BNTX and whatever MKW's successor formats are);
4. decode to glTF with skeleton, skin weights, materials and textures;
5. validate the result in Blender.

That produces usable, inspectable assets. Turning them back into something the
console will load is the part that is blocked, and it is blocked at the
signature/mod-loader layer rather than anywhere we can reach from a save.
