#!/bin/sh
# Deprecated network fetcher; use the version-pinned bootstrap shipped in assets/.
set -eu
cd "$(dirname "$0")"
echo 'The pinned bootstrap is already available at assets/bootstrap.bas.'
echo 'No network download is performed; unpinned updates are deliberately disabled.'
shasum -a 256 -c assets/bootstrap.bas.sha256
