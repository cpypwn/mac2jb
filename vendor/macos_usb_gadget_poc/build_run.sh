#!/bin/zsh
export PATH="${HOMEBREW_PREFIX}/opt/llvm/bin:$PATH"
cd usb_device && make clean && make && ./usb_device