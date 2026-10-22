# macos_usb_gadget_poc

This repository contains a proof-of-concept for interfacing with IOUSBDeviceFamily on ARM64 MacBooks. Currently it implements a HID keyboard which types "my laptop is a keyboard. " over and over.

**Requirements:**

 - SIP must be disabled (`sudo spctl --master-disable`)
 - `usbgadget.kext` must be loaded

**Caveats:**

 - The example hardcodes for the right port on a 2021 MBP.
 - This probably will also break network sharing on the port after use. It's fixable via reboot, or by calling `IOUSBDeviceDescriptionAppendInterfaceToConfiguration` with all the original NCM functions.

**What does the kext do?**

 - `usbgadget.kext` is used to bypass an entitlement check in `IOUSBDeviceController::createUSBDevice` for `com.apple.private.usbdevice.setdescription`. This can normally be worked around via disabling AMFI, but disabling AMFI was extremely unstable on my system (Firefox would hang, Discord would fail to launch). This might have been able to be worked around by injecting into a process with the entitlement, but macOS does not use `lockdownd`.
 - Setting the property `PublishConfiguration` in `gay_bowser_usbgadget` will forward the dict to the parent `IOUSBController` (with `USBDeviceCommand=SetDeviceConfiguration`). Since this is done from a kernel thread, it bypasses the entitlement check.
 - There's a version that doesn't use the kext (ie, requires `amfi_get_out_of_my_way=1`) in the initial commit of the repo.

**Compiling/Running:**

 - Take a look at `load.sh` for fixing/loading `usbgadget.kext`. You'll have to approve the kext once in System Security before it'll work.
   - If you want to build from scratch, there's an Xcode project.
 - `cd usb_device && make clean && make && ./usb_device`