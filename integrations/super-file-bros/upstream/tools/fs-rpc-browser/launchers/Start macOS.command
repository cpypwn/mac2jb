#!/bin/sh
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
cd -- "$(dirname -- "$0")" || exit 1
sh ./start.sh "$@"
result=$?
if [ "$result" -ne 0 ]; then printf '\nPress Enter to close...'; read -r answer; fi
exit "$result"
