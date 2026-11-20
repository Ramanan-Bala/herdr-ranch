#!/bin/sh
# Prints Antigravity's usage limits (one JSON object) and exits.
#
# Runs `agy -p /usage --output-format json`; the CLI authenticates itself,
# starts no agent turn, spends no quota and saves no conversation. This script
# reads no tokens or credential files.
#
# Exit: 0 = printed the reply, 127 = agy CLI not found, 1 = no reply in
# 15 s or no usable reply.
# Override the binary with HERDR_USAGE_AGY_BIN.

AGY=$(command -v "${HERDR_USAGE_AGY_BIN:-agy}" 2>/dev/null) || exit 127

dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-antigravity-usage.XXXXXX") || exit 1
out="$dir/out"

"$AGY" -p /usage --output-format json >"$out" 2>/dev/null &
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
if grep -q '"status"' "$out" 2>/dev/null; then
  cat "$out"
  status=0
fi
rm -rf "$dir"
exit $status
