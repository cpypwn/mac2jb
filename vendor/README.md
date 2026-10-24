# Vendored upstream components

The pinned source revisions and project URLs are listed in `../upstream.lock`.
The MIT licenses and APSL 2.0 license texts are retained alongside the relevant
source files. Root `LICENSE` does not override third-party terms.

- **libusbd:** based on upstream libusbd, with two local modifications in
  `Makefile` and `src/plat/macos/impl.c` documented by dated notices.
- **macos_usb_gadget_poc:** intentionally trimmed upstream source. Contains
  `usbgadget/` (MIT-licensed kernel extension source and Xcode project), plus
  provenance README and APSL text. The unused `usb_device/` proof of concept,
  upstream convenience shell scripts, prebuilt `usbgadget.kext/`, and machine-local
  Xcode user settings are excluded. This is **not** a byte-for-byte upstream tree.
- **ns2jb:** pinned upstream source. Any redistributor must establish their own
  rights to ship it; a Git URL or public availability alone is not a license.

Do not run `scripts/freeze-upstream.sh` in a normal user installation. It is a
maintainer-only source refresh requiring a new provenance, license and security
review before publication.
