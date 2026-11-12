#!/usr/bin/env python3
"""Interpreter-oriented rewrites of the wasm2js output (formatted --profiling build).

Pass "locals": inside each function that touches a typed-array heap view at
least MIN_REFS times, alias the module-scope views (HEAPU8, HEAP32, ...) into
function locals, so the jitless interpreter reads a register instead of a
context slot on every memory access. The heap never grows
(ALLOW_MEMORY_GROWTH=0), so the views are constant for the module lifetime.

Usage: postpass.py IN.js OUT.js [--min-refs N]
"""
import re
import sys

VIEWS = ['HEAP8', 'HEAPU8', 'HEAP16', 'HEAPU16', 'HEAP32', 'HEAPU32', 'HEAPF32', 'HEAPF64']
LOCAL = {v: '$$' + v for v in VIEWS}
FUNC = re.compile(r'^ function ([A-Za-z0-9_$]+)\(([^)]*)\) \{$')


def rewrite(source, min_refs=4):
    lines = source.split('\n')
    starts = [i for i, l in enumerate(lines) if FUNC.match(l)]
    if not starts:
        raise SystemExit('No wasm2js functions found; build with --profiling formatting')
    out = list(lines)
    changed = 0
    for n, start in enumerate(starts):
        end = start + 1  # the function's own closing brace at module indentation
        while end < len(lines) and lines[end] != ' }':
            end += 1
        if end >= len(lines):
            raise SystemExit('Unterminated function at line %d' % (start + 1))
        body = '\n'.join(lines[start + 1:end])
        counts = {v: len(re.findall(r'\b' + v + r'\[', body)) for v in VIEWS}
        used = [v for v in VIEWS if counts[v] >= min_refs]
        if not used:
            continue
        for v in used:
            body = re.sub(r'\b' + v + r'\[', LOCAL[v] + '[', body)
        decl = '  var ' + ', '.join(LOCAL[v] + ' = ' + v for v in used) + ';'
        new = body.split('\n')
        out[start + 1:end] = [None] * (end - start - 1)
        out[start + 1] = decl + '\n' + '\n'.join(new)
        changed += 1
    result = '\n'.join(l for l in out if l is not None)
    return result, changed


if __name__ == '__main__':
    args = sys.argv[1:]
    min_refs = 4
    if '--min-refs' in args:
        i = args.index('--min-refs'); min_refs = int(args[i + 1]); del args[i:i + 2]
    src = open(args[0]).read()
    res, changed = rewrite(src, min_refs)
    open(args[1], 'w').write(res)
    print(f'postpass: aliased heap views in {changed} functions', file=sys.stderr)
