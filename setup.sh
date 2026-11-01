#!/bin/sh
# dsh-upgrade setup: unpack-and-run installation for Linux.
# ASCII only: this file is read by /bin/sh, which may be a minimal shell.
#
# usage: sh setup.sh [root-dir]
#   root-dir  parent directory that will hold deepseek-harness and dsh-slots.
#             Defaults to the parent of this folder.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=${1:-$(dirname -- "$HERE")}
CONFIG="$HERE/dsh-upgrade.json"
CLI="$HERE/src/cli.ts"

echo "dsh-upgrade setup"
echo "  tool   $HERE"
echo "  root   $ROOT"
echo

command -v node >/dev/null 2>&1 || {
  echo "[x] Node.js 24 or newer is required: https://nodejs.org"
  exit 1
}
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "[x] Node.js 24 or newer is required; found $(node -p "process.versions.node")"
  exit 1
fi
echo "  node   $(node -p "process.versions.node")"

echo
if [ -f "$CONFIG" ]; then
  echo "[1/3] keeping the existing configuration"
  echo "       $CONFIG"
else
  echo "[1/3] creating the layout under $ROOT"
  node "$CLI" --config "$CONFIG" init --root "$ROOT"
fi

echo
echo "[2/3] checking the machine"
if ! node "$CLI" --config "$CONFIG" doctor; then
  echo "[!] doctor reported a blocking problem. Fix it and run this file again."
  exit 1
fi

echo
echo "[3/3] creating the application launchers"
if ! node "$CLI" --config "$CONFIG" shortcuts --install; then
  echo "[!] the launchers were not created; the CLI still works."
fi

echo
echo "Done. Next steps:"
echo "  check          see whether a newer version exists"
echo "  stage          prepare it in the spare slot"
echo "  apply          switch to it"
echo "  task install   check for new versions every 20 minutes"
echo
echo "Every command takes --config \"$CONFIG\" when run from another folder."
echo
