#!/bin/zsh
make clean && make
#cd examples/keyboard/ ; make clean && make && cp ./example_keyboard ../../ && cd ../../ && ./example_keyboard
#cd examples/gamepad/ ; make clean && make && cp ./example_gamepad ../../ && cd ../../ && ./example_gamepad
#cd examples/nintendo/ ; make clean && make && cp ./example_nintendo ../../ && cd ../../ && ./example_nintendo
#cd examples/ums/ ; make clean && make && cp ./example_ums ../../ && cd ../../ && ./example_ums ubuntu-18.04.6-desktop-amd64.iso
#cd examples/ums/ ; make clean && make && cp ./example_ums ../../ && cd ../../ && ./example_ums -w /Users/maxamillion/workspace/brunch/chromeos.img
#cd examples/ums/ ; make clean && make && cp ./example_ums ../../ && cd ../../ && ./example_ums /Users/maxamillion/Downloads/iPod_1.2_36B10147/rsrc.img
#cd examples/ums/ ; make clean && make && cp ./example_ums ../../ && cd ../../ && ./example_ums /Users/maxamillion/Downloads/iPod_1.0.2_34A20020/rsrc.img
#cd examples/ums/ ; make clean && make && cp ./example_ums ../../ && cd ../../ && ./example_ums /Users/maxamillion/Downloads/iPod_1.0.1_37A10002/rsrc.img

cd examples/nintendo_mitm/ ; make clean && make && cp ./example_nintendo_mitm ../../ && cd ../../ && ./example_nintendo_mitm