#!/bin/sh
# Prints OpenCode Go's usage limits (one JSON object) and exits.
#
# Runs `opencode api GET /api/experimental/usage/limits`, which asks OpenCode's
# own local server; the CLI authenticates itself. This script reads no tokens
# or credential files.
#
# Exit: 0 = printed the reply, 127 = opencode CLI not found, 1 = no reply in
# 15 s or no usable reply.
# Override the binary with HERDR_USAGE_OPENCODE_BIN.

OC=$(command -v "${HERDR_USAGE_OPENCODE_BIN:-opencode}" 2>/dev/null) || {
  # OpenCode's installer puts it at ~/.opencode/bin/opencode, often not on PATH.
  [ -x "$HOME/.opencode/bin/opencode" ] || exit 127
  OC="$HOME/.opencode/bin/opencode"
}

dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-opencode-usage.XXXXXX") || exit 1
out="$dir/out"

"$OC" api GET /api/experimental/usage/limits >"$out" 2>/dev/null &
pid=$!

i=0
while [ "$i" -lt 75 ]; do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
  i=$((i + 1))
done
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null

status=1
if grep -q '"data"' "$out" 2>/dev/null; then
  cat "$out"
  status=0
fi
rm -rf "$dir"
exit $status
