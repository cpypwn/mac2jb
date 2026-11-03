#!/bin/zsh
# Keeps the latest capture-card frame on disk for tools that cannot open the
# camera themselves. Claude Code's shell runs as com.anthropic.claude-code,
# which has no camera grant and cannot prompt for one, so AVFoundation hands it
# zero frames without an error. Launched through Terminal (which has the grant):
#
#   open -g -a Terminal ~/ns2-savekit/tools/capture-daemon.command
#
# Writes /tmp/ns2cap/latest.png about twice a second; stop with
#   pkill -f ns2cap/latest.png
OUT=/tmp/ns2cap
mkdir -p $OUT
exec ffmpeg -loglevel error -f avfoundation -pixel_format uyvy422 -framerate 30 \
  -video_size 1920x1080 -i "0:none" -vf fps=2 -update 1 -y $OUT/latest.png
