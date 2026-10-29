# Local release workflow and safe testing

Start with the [plain-English FAQ](../FAQ.md#git-and-release-work) if Git is new to you. This guide is included for reference in the runtime too, but developer commands below require the **release source repository**, not just an extracted/installed runtime archive. [Release preparation folder](README.md) · [Main README](../README.md).

## Two independent projects

The experimental project is the lab. The release project contains only the public distribution profile: File Exchange, both console shells, IZMYSH and two optional original-engine adapters. Their Git histories are separate. No GitHub remote is configured automatically.

- A **commit** is a named checkpoint of source files. Running processes and private `data/` are outside it.
- **main** is the accepted release source.
- **candidate/...** is a proposed import. Preparing it does not change main.
- An archive is built from a clean committed release tree, never from the running lab.

The initial local author is `IZMYSH <local@iz2s.invalid>`, a technical placeholder. Before public commits, set your own repository-local identity (`git config user.name ...` and `git config user.email ...`). A GitHub no-reply email is suitable. The placeholder is not a real address.

Open the release folder in VS Code. **Terminal → Run Task** exposes the release actions; **Ctrl+Shift+B** builds the archive. The existing IZ2S Platform shortcut remains the test copy; the Release Git/Preview shortcuts are local development conveniences. Source Control shows changed files; clicking a file shows its diff. Review and commit deliberately. The initial local checkpoint includes only curated sources; `.gitignore` excludes private state, keys, external runtimes and downloaded engines. Do not force-add these files. The automated scan detects several common key/token patterns, not every possible secret; review diffs before public pushes.

## Promote changes from the lab

All commands below run in the release folder. The source path is kept in ignored `.dev/local.json`; you can always override it with `--source`.

```sh
# 1. In the lab: review and commit only finished files in VS Code.
# The snapshot helper stages ALL non-ignored lab edits; use it only when all are intentional.
# Optional alternative: python3 distribution/workflow.py snapshot --source /path/to/lab -m "Describe the finished change"
# 2. Import only files allowed by the release profile into a candidate branch.
python3 distribution/workflow.py prepare --source /path/to/lab
# 3. Review, check, preview and exercise the candidate.
python3 distribution/workflow.py review
python3 distribution/workflow.py verify
./preview.sh
./distribution/test-install.sh
# 4. Once satisfied, accept locally and build a release archive.
python3 distribution/workflow.py accept
python3 distribution/workflow.py build
```

`prepare` uses committed lab sources. Unsaved/uncommitted lab edits are not imported. Release-only edits are preserved when the corresponding lab file is unchanged. If both projects changed a file differently, promotion stops before changing anything and names the files to merge. There is no destructive reset, forced push or automatic publication. `accept` uses a fast-forward merge and checks the candidate again.

To return to the accepted source without accepting a candidate, commit any edits first, then `git switch main`. The candidate branch stays available. For a bad accepted change, use VS Code **Git: Revert Commit** or `git revert <commit>`; avoid reset/clean while learning.

`build` creates `dist/iz2s-platform-<version>-file-exchange.tar.gz` and a SHA256 file. It includes the root README, FAQ and the relevant folder guides, repacks only File Exchange and the ARM agent, validates their descriptors and records the Git commit in `release.json`. Private settings, installed original engines, test suites and developer tools are omitted. Runtime compatibility checks needed for safe console startup remain included.

## Four levels of testing

| Method | Use it for | Changes to the host |
| --- | --- | --- |
| `./preview.sh` | Layout, icons, navigation and public module list | Temporary application copy only; not a security sandbox |
| `./distribution/test-install.sh` | Copying files, module packaging, dependency checks | Temporary install only; system packages and desktop shortcut disabled |
| `./distribution/container.sh` | Clean Linux dependencies, real installer in image, read-only panel | Container image/cache; no host folders or devices mounted |
| VM with snapshot | Complete first installation, desktop shortcut, sudo/package-manager behavior | Guest OS only |

The isolated-folder test still runs ordinary local code and can download a private Node.js runtime into its temporary directory. It does not isolate malicious code. The container offers stronger isolation; a VM has a separate kernel and is the best choice for testing changes to system configuration.

### Containers

Install rootless Podman or configure rootless Docker using its official documentation, then run `./distribution/container.sh`. Rootless mode avoids running the container engine as root. Do not add `--privileged`, host networking, Docker socket mounts, home-directory mounts, SSH credentials or USB passthrough for this preview.

The image runs the installer on Debian, runs the preview as an unprivileged user and exposes only `http://127.0.0.1:39518/` on the host. Copy the launch link printed by the container, including its private fragment. The bridge rejects writes. Port 39518 must be free. Use `IZ2S_PREVIEW_PORT=39519 ./distribution/container.sh` to choose another port; the production panel port is unchanged.

The image recipe uses `node:24-bookworm-slim`. For repeatable public CI, pin its reviewed digest. No container engine is installed, enabled or started by IZ2S tooling. A build needs internet access. This test covers Debian x64 on an x64 host; ARM64 needs an ARM64 machine or a separately configured emulator and is not implied by an x64 pass.

### Complete installation in a VM

1. Create a disposable Debian/Ubuntu VM in GNOME Boxes, virt-manager/KVM or VirtualBox. Use a normal user with sudo and install the guest desktop.
2. Take a snapshot named `Clean Linux` before installing IZ2S.
3. Transfer the release archive and its `.sha256` file to the guest. Verify with `sha256sum -c <archive>.sha256`, extract it and run `./install.sh --check`, then `./install.sh`.
4. Check dependency installation, the application-menu shortcut, panel launch and removal of the installed version directory. The desktop shortcut is a separate file under the guest's `~/.local/share/applications/`.
5. Restore the snapshot and repeat. Use a second Arch VM to check pacman behavior.

A container/VM preview cannot prove actual Switch, GPU, ARM USB gadget or dock/Wi-Fi behavior. Those require a dedicated hardware session after software packaging passes. No test here uploads or runs a bootstrap on your console.

## First GitHub publication, later

Create an empty repository on GitHub when ready. Review the complete tracked tree, license notices and the first commit, then add the remote and push main. Do not put a token in a remote URL. Use a Git credential manager or SSH. Add a tag only after checking the release artifact. This preparation deliberately creates no remote, tag publication or public release.

Official references: [Git commits](https://git-scm.com/docs/git-commit), [Git branches](https://git-scm.com/book/en/v2/Git-Branching-Branches-in-a-Nutshell), [Docker rootless](https://docs.docker.com/engine/security/rootless/), [Podman rootless](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md).

## Every release needs a complete guide

Follow the [release description template](RELEASE-TEMPLATE.md). Each new release must include What’s new, download/install, exact-tag source build commands, validation and support details. Keep the practical installation instructions from the previous release and update them for the new version.
