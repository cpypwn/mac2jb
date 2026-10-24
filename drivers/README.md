# Bundled USB gadget driver

`usbgadget.kext` is the maintainer's tested, locally built arm64e driver, version 1.01, identifier `gay.bowser.usbgadget`. Its personal development signature was removed from a copy; the installed working driver was not included with its certificate. The unsigned copy passed reboot/loading, USB enumeration, and typing tests reported by the maintainer on the README's tested Mac. Other Macs/macOS versions remain unverified.

Executable SHA-256: `a32119c7908098c49c2540a17aad4d172378de969885ad4f4a752bdb8ef91308`.
Mach-O UUID: `124391F6-0CFF-32E0-8884-6F6360DF5D1C`.
Build metadata: Xcode 26.6 / macOS SDK 26.5; minimum OS recorded as 11. This is not a claim of compatibility with every OS from 11 onward.

Upstream: https://github.com/shinyquagsire23/macos_usb_gadget_poc
The bundled source snapshot is at `../vendor/macos_usb_gadget_poc/usbgadget/`, pinned in `../upstream.lock`. This binary is a local build, not the upstream prebuilt artifact; bit-for-bit reproducibility against that snapshot has not been established. Source-build instructions remain in the root README.

Copyright © 2022 Max Thomas. Upstream MIT license: `../vendor/macos_usb_gadget_poc/usbgadget/LICENSE`. Apple-derived source notices and APSL text are retained in `../vendor/macos_usb_gadget_poc/`. These licenses are also included alongside this file for standalone driver packaging.

SIP must be disabled for this unsigned-driver workflow. Enable third-party kernel extensions in Recovery and complete any macOS approval/reboot prompts. Neither the GUI nor the installer changes startup security or SIP.

Thanks to **SocraticBliss** for the feedback and guidance behind the simplified prebuilt-driver installation path and clearer SIP instructions. The driver itself is upstream work by **Max Thomas / shinyquagsire23**, with the local build and unsigned-copy testing performed by the mac2jb maintainer.

From the complete source checkout: `bash scripts/install-driver.sh`. To validate the bundled files without installing or loading: `bash scripts/install-driver.sh --verify`.

The installer preserves an existing driver under `/Library/Extensions/.mac2jb-usbgadget-backup-<UUID>` and prints the exact path. Do not delete that backup until the replacement has been verified after a restart. If loading fails, the installed copy and backup remain available for diagnosis/recovery.
