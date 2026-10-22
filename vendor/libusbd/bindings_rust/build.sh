#!/bin/zsh

cd ..
make clean && make
cd bindings_rust

export LIBUSBD_INCLUDE_DIR=$(pwd)/../include
export LIBUSBD_LIB_DIR=$(pwd)/..
cp $LIBUSBD_LIBS/libusbd.dylib . # for tests

cargo build
cargo test