#!/bin/sh
# Herdr mods cannot import outside their own folder, so the shared helpers in
# lib/ are copied into mods/ranch-*/lib/ (only the files each mod imports; see
# scripts/sync-lib.mjs). Edit lib/, never the copies.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
node "$root/scripts/sync-lib.mjs" "$@"
