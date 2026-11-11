#!/bin/sh
# Runs `herdr-app check` on Ranch mods and validates the layout/keys JSON.
# Usage: sh scripts/check.sh            -> every mods/ranch-*
#        sh scripts/check.sh ranch-chrome -> just that mod
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
status=0
if [ -n "$1" ]; then mods="$root/mods/$1/"; else mods=$(ls -d "$root"/mods/ranch-*/); fi
for mod in $mods; do
  [ -f "$mod/main.js" ] || { [ -n "$1" ] && { echo "no main.js in $mod"; status=1; }; continue; }
  if ! herdr-app check "${mod%/}"; then status=1; fi
done
for f in "$root"/layouts/*.json "$root"/keys.json; do
  [ -f "$f" ] || continue
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" || { echo "invalid JSON: $f"; status=1; }
done
exit $status
