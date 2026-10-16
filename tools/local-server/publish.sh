#!/bin/zsh
# Copies the current working tree of the site to the internal disk, where the launchd
# server can read it (launchd jobs are blocked from /Volumes/Work by macOS privacy rules).
# Run after every change you want to see on the phone.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$HOME/Library/Application Support/Frequencier"
mkdir -p "$BASE/site" "$BASE/logs"
cp "$REPO/tools/local-server/serve.py" "$BASE/serve.py"
rsync -a --delete --exclude '.*' --exclude 'certs/' --exclude 'tools/' --exclude '*.md' "$REPO/" "$BASE/site/"
echo "published to $BASE/site"
