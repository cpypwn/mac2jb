#!/bin/bash
export LIBUSBD_INCLUDE_DIR=$(pwd)/../../include
export LIBUSBD_LIB_DIR=$(pwd)/../..

#export WAYLAND_DISPLAY=wayland-0
#export XDG_RUNTIME_DIR=/run/user/1000

TMP_BUILD_WD=$(pwd)
cd ../../
make -f Makefile.linux clean && make -f Makefile.linux && cd $TMP_BUILD_WD && cp $LIBUSBD_LIB_DIR/libusbd.so . && cargo build && sudo WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 LD_LIBRARY_PATH=. target/debug/rust_kvm
