# Release description template

For every release, keep the installation and build guidance, update exact versions/asset names, and add a concrete What’s new section. Do not replace the guide with a changelog alone.

Required sections:

1. **What’s new**: visible behavior, newly available controls and material compatibility changes compared with the previous release.
2. **Download and install**: prepared archive name, SHA256 verification, extraction, `./install.sh --check`, `./install.sh` and how to start the installed copy. Distinguish it from GitHub’s automatic Source code archives.
3. **Build from source**: repository URL, exact release tag, Node/tool requirements, menu rebuild commands, validation and packaging from a clean committed tree.
4. **Validation and support**: what was tested, what remains untested, supported host platforms and links to README/FAQ/SUPPORT.

Use the current [release notes](../RELEASE-NOTES.md) as the filled-in example. Prepare notes and assets before publishing, preserve existing source history, and verify published asset checksums and version metadata afterward. Never publish private settings, user profiles, credentials or unrelated lab changes.
