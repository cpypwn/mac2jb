#!/bin/zsh
sudo chown -R 'maxamillion:staff' usbgadget.kext
rm -rf usbgadget.kext

cp -R /Users/maxamillion/Library/Developer/Xcode/DerivedData/usbgadget-aafdftbbvuodhsclkkxyqrqtbknh/Build/Products/Debug/usbgadget.kext usbgadget.kext
sudo chown -R root:wheel usbgadget.kext
sudo sync
sudo kextload usbgadget.kext
