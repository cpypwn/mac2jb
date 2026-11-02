# picohttpparser (vendored)

- Source: https://github.com/h2o/picohttpparser
- Commit: `465a7ff09fbd3432fe56c673451f5460154d1f07` (2026-09-29)
- Authors: Kazuho Oku, Tokuhiro Matsuno, Daisuke Murase, Shigeo Mitsunari
- License: MIT or Perl, at your option (MIT text is in each file's header)

`picohttpparser.c` and `picohttpparser.h` are **verbatim** copies; diff them against the commit above.
Freestanding builds get `<string.h>`, `<assert.h>` and `<sys/types.h>` from `../../shim/` instead of
patching these files. Only `phr_parse_request` is used; `--gc-sections` drops the rest.
