# macos_usb_gadget_poc (trimmed source snapshot)

Origin: https://github.com/shinyquagsire23/macos_usb_gadget_poc
Pinned upstream revision: see ../../upstream.lock

This directory intentionally contains only the `usbgadget/` kernel-extension
source, Xcode project, and its MIT license. The original unrelated
`usb_device/` example, upstream run/install scripts, and old prebuilt
`usbgadget.kext/` are excluded because mac2jb does not need to ship them.
The complete original repository is available from the origin link above.

See `usbgadget/LICENSE` for upstream MIT terms. Review the security and code
signing implications before installing a kernel extension. This directory
is not an unchanged copy of the original repository.
