#!/usr/bin/env python3
import os
import sys


def main():
    clang = os.environ["MAC2JB_HBL_CLANG"]
    lld_bin = os.environ["MAC2JB_HBL_LLD_BIN"]
    vulkan_include = os.environ["MAC2JB_HBL_VULKAN_INCLUDE"]
    args = [arg for arg in sys.argv[1:] if arg not in ("-lgcc", "-no-pie")]
    command = [clang, "--target=aarch64-none-elf", "-I" + vulkan_include]
    if "-c" not in args:
        command.extend(("-fuse-ld=lld", "-B" + lld_bin))
    command.extend(args)
    command.append("-Wno-unused-but-set-global")
    os.execv(clang, command)


if __name__ == "__main__":
    main()
