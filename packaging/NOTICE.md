# mac2jb 0.3.1 packaging

The app and complete source distribution include the tested unsigned local
`usbgadget.kext` build, with hashes and provenance in `drivers/README.md`.
Its personal signing certificate has been removed. Source-build instructions
and the vendor source/license remain included.

SocraticBliss contributed feedback and guidance on simplifying driver setup and
documenting the SIP requirement. The USB driver is by Max Thomas / shinyquagsire23;
its upstream author credits and licenses are retained.

The executable embeds the native mac2jb senders, libusbd, the pinned ns2jb
snapshot, the bootstrap, and an Apple Silicon Node.js runtime. It extracts a
new private session folder under `~/Library/Application Support/mac2jb/Sessions/`
for every launch. Runtime downloads, a separate Node installation, Xcode, and
Command Line Tools are not required to run this built demo. Those development
tools can still be needed to build and install a compatible USB gadget driver.

Corresponding mac2jb and libusbd source and all retained vendor notices are
embedded under `source/`; the build also produces a separate source archive.
The upstream origin and revisions remain recorded in `source/upstream.lock`.
The root MIT license applies to mac2jb; it does not relicense third-party code.

- libusbd: Max Thomas / shinyquagsire23; MIT notice preserved, together with
  Apple-derived APSL 2.0 source notices and full license text. Existing dated
  downstream modification notices are retained. This GUI build does not modify
  the libusbd sources or its existing build configuration.
- macos_usb_gadget_poc: the documented, trimmed kernel-extension source and
  license texts remain included. The separately documented local prebuilt is
  under `drivers/`; the old upstream prebuilt is not used.
- ns2jb: the pinned upstream snapshot and existing README/provenance remain
  preserved. No new license is asserted for this snapshot. The existing
  redistribution/third-party-rights review requirement still applies before a
  public release. GUI orchestration is separate from the vendor source.
- Node.js: the bundled version's complete upstream LICENSE, including its
  third-party notices, is included as `licenses/node-LICENSE.txt`. The runtime
  version and local-binary hash are recorded in `licenses/node-provenance.json`.
  The evaluation build uses the arm64 slice of the locally installed official
  Node distribution, whose linked libraries must all be supplied by macOS.

The GUI never silently changes Reduced Security, SIP, kernel-extension
approval, or firewall policy. The app is ad hoc signed for local evaluation,
not Developer ID signed or notarized.

The smile mark in `gui/KeyboardMark.swift` is original mac2jb artwork used
only for the app icon. The GUI's wordmark is plain text. The app icon does not
export, trace, or modify an Apple SF Symbol. Other system symbols appear as normal
interface elements. Apple's SF Symbols usage restrictions are documented at
https://developer.apple.com/design/human-interface-guidelines/sf-symbols.
