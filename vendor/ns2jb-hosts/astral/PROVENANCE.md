# Astral host — provenance

This repository is a **pinned ns2jb host source** published so it can be
vendored into mac2jb as the `astral` host profile
(`vendor/ns2jb-hosts/astral`).

## Base

- Upstream: <https://gitlab.com/kurumuz/ns2jb>
- Revision: `81d5bb114c856109dadaf1077d927a9f297fe58d`
- The root `README.md` and original source notices from that upstream are
  retained unchanged.

## What this fork changes

A small, targeted set of changes relative to the kurumuz baseline:

| File | Change |
| --- | --- |
| `engine/switch2/memory/alias-retry.cjs` | New. Bounded, explicit retry accounting for the "clean alias" step (`cleanAliasDecision`). |
| `engine/switch2/memory/probe-reserved-gap.cjs` | Uses the new retry accounting (`cleanAliasAttempts = 8`) instead of aborting on the attempt-count boundary. |
| `engine/switch2/acquire.cjs` | Single fresh-session attempt (down from 3) and clearer diagnostics when acquisition fails. |
| `run.cjs` | Prints the host identity line on launch. |

The bootstrap (`bootstrap.bas`, five-argument `V=START`) is byte-identical to the
kurumuz baseline.

## Vendor fingerprints

mac2jb's `scripts/host-profiles.cjs` computes `sourceDigest` over
`run.cjs`, `bootstrap.bas`, `rpc.cjs`, `dump-firmware.cjs` and everything under
`engine/`. For this tree:

- `sourceSha256` = `75a1036ea4575174f994ac79d153ab2dabbf210237508dbc9f8138cc59e0015c`
- `bootstrapSha256` = `dca34ac7977cfd3f7cb657a79da925450472b6527ea83d022a9aa25510b168d5`

`SHA256SUMS` covers every file in this repository except itself. Verify with:

```sh
shasum -a 256 -c SHA256SUMS
```

## Attribution / license

The pinned upstream supplies no license file; this repository retains the
upstream `README.md` and original notices. Review redistributability before
mirroring or republishing. This repository is research tooling for a console you
own and is not affiliated with or endorsed by Nintendo.
