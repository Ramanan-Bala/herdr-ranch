#!/bin/sh
# Development install: symlink Ranch's layout and mods into Herdr's home so
# edits here show up live. Never overwrites: an existing non-symlink with the
# same name is left alone and reported. Undo with: sh scripts/link-dev.sh --unlink
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
herdr="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
sh "$root/scripts/sync-lib.sh"
link() { # $1 source, $2 target
  if [ -L "$2" ]; then ln -sfn "$1" "$2"; echo "linked  $2"
  elif [ -e "$2" ]; then echo "SKIPPED $2 (exists and is not a Ranch link)"
  else ln -s "$1" "$2"; echo "linked  $2"; fi
}
unlink_one() { [ -L "$1" ] && rm "$1" && echo "removed $1" || true; }
targets="layouts/ranch.json layouts/ranch.svg"
for m in "$root"/mods/ranch-*/; do targets="$targets mods/$(basename "$m")"; done
for t in $targets; do
  if [ "$1" = "--unlink" ]; then unlink_one "$herdr/$t"; else link "$root/$t" "$herdr/$t"; fi
done
# Herdr doesn't hot-reload mods through symlinks; --reload restarts Ranch's mods
# by switching away and back (the focused tab is kept).
if [ "$1" = "--reload" ] || [ "$2" = "--reload" ]; then
  tab=$(herdr-app status | sed -n 's/.*"tab": "\(tb[^"]*\)".*/\1/p' | head -1)
  herdr-app do layout.switch --name main >/dev/null
  herdr-app do layout.switch --name ranch >/dev/null
  [ -n "$tab" ] && herdr-app do tab.select --id "$tab" >/dev/null
  echo "reloaded Ranch"
fi
