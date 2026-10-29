"""Disassemble a bounded function from a private, user-supplied module capture.
Install Capstone in a venv: python -m pip install capstone
Offsets are module-relative. This tool never calls the console.
"""
import argparse
from pathlib import Path
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('binary', type=Path)
parser.add_argument('offset', type=lambda s: int(s, 0))
parser.add_argument('--bytes', type=lambda s: int(s, 0), default=256)
args = parser.parse_args()
if args.offset < 0 or args.offset % 4 or not 4 <= args.bytes <= 4096 or args.bytes % 4:
    parser.error('Use an aligned nonnegative offset and 4..4096 aligned bytes')
with args.binary.open('rb') as source:
    source.seek(args.offset)
    data = source.read(args.bytes)
if len(data) != args.bytes:
    parser.error('Requested range exceeds capture')
for instruction in Cs(CS_ARCH_ARM64, CS_MODE_ARM).disasm(data, args.offset):
    print(f'{instruction.address:08x}  {instruction.mnemonic:8} {instruction.op_str}')
