#!/bin/sh
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
cd -- "$(dirname -- "$0")" || exit 1
sh './Install shortcut.sh'
printf '\nPress Enter to close...'
read -r answer
