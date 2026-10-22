#!/bin/zsh
export LIBUSBD_INCLUDE_DIR=$(pwd)/../../include
export LIBUSBD_LIB_DIR=$(pwd)/../..

TMP_BUILD_WD=$(pwd)
cd ../../
make clean && make && cd $TMP_BUILD_WD && cp $LIBUSBD_LIB_DIR/libusbd.dylib . && cargo run
