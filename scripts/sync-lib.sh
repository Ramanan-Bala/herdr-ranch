#!/bin/sh
# Herdr mods cannot import outside their own folder, so the shared helpers in
# lib/ are copied into every mods/ranch-*/lib/. Edit lib/, never the copies.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
for mod in "$root"/mods/ranch-*/; do
  [ -f "$mod/main.js" ] || continue
  mkdir -p "$mod/lib"
  for f in "$root"/lib/*.js; do
    [ -e "$f" ] || continue
    cp "$f" "$mod/lib/"
  done
done
