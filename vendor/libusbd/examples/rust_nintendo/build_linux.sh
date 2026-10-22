#!/bin/bash
export LIBUSBD_INCLUDE_DIR=$(pwd)/../../include
export LIBUSBD_LIB_DIR=$(pwd)/../..

TMP_BUILD_WD=$(pwd)
cd ../../

#gdb -ex run
make -f Makefile.linux clean && make -f Makefile.linux && cd $TMP_BUILD_WD && cp $LIBUSBD_LIB_DIR/libusbd.so . && cargo build && sudo LD_LIBRARY_PATH=. target/debug/rust_nintendo
