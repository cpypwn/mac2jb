# Working on VacooTube

This repository is the canonical source for the separate VacooTube project. The IZ2S Platform production repository remains a small host distribution; it does not silently absorb this project or its runtime.

1. Open this folder in VS Code and create a feature branch before experimenting.
2. Make source changes here, then check/package with `node tools/module.cjs check --platform /path/to/IZ2S` and `pack` with the same option.
3. Install intentionally into a test platform with `install.sh --platform /path/to/test/IZ2S --replace`. Add `--with-runtime` when supplying the prepared player runtime. The previous module is backed up. Stop affected sessions before replacing them.
4. Test only the affected behavior. Host checks do not establish physical Switch behavior; use a fresh console session for changes to pinned packages.
5. Review the diff and commit finished changes. Accept the branch into local main when satisfied, then build with `node tools/module.cjs release --platform /path/to/IZ2S`.

A clean source tree is required for release creation. Do not edit active `.versions/` or prepared runtime source as the canonical code. Do not commit private data, caches, downloaded runtimes or credentials. Generated .izm and tar archives belong to release assets, not Git source history.

No GitHub remote or automatic publication is configured. The initial local author uses the technical placeholder `IZMYSH <local@iz2s.invalid>`; choose your real/public no-reply identity before future public commits. Preserve component license notices and inherited review markers.

[Back to README](README.md).
