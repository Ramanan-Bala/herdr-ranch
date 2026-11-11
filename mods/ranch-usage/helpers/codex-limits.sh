#!/bin/sh
# Prints Codex's rate limits as one JSON line and exits.
# Approach credit: Joseph Malicki's jmalicki/herdr-mod-ai-usage (MIT), whose collector
# reads `codex app-server` account/rateLimits/read. No code is copied from it.
#
# Asks `codex app-server` (JSON-RPC: initialize, initialized,
# account/rateLimits/read); Codex authenticates itself and this script reads no
# tokens. If that fails, prints the newest rate-limit snapshot Codex logged in
# its sessions (last 14 days) as {"snapshot": <line>}.
#
# Exit: 0 = printed something, 127 = codex CLI not found,
# 1 = codex found but no reply and no snapshot.
# Override the binary with HERDR_USAGE_CODEX_BIN; sessions follow CODEX_HOME.

# Not installed: say so, even if old session logs exist (they'd look like a reading).
CODEX=$(command -v "${HERDR_USAGE_CODEX_BIN:-codex}" 2>/dev/null) || exit 127

{
  dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-codex-limits.XXXXXX") || exit 1
  out="$dir/out"
  if mkfifo "$dir/in"; then
    "$CODEX" app-server <"$dir/in" >"$out" 2>/dev/null &
    pid=$!
    exec 3>"$dir/in"
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"herdr-usage-limits","version":"1.0"}}}' >&3
    printf '%s\n' '{"jsonrpc":"2.0","method":"initialized"}' >&3
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}' >&3

    i=0
    while [ "$i" -lt 75 ]; do
      if grep -q '"id":2' "$out" 2>/dev/null; then break; fi
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
      i=$((i + 1))
    done
    exec 3>&-
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null

    if grep -m1 '"id":2' "$out"; then
      rm -rf "$dir"
      exit 0
    fi
  fi
  rm -rf "$dir"
}

# app-server didn't answer: offer the newest logged snapshot (the mod shows it
# as the last reading, dated, with the provider marked as failing).
sessions="${CODEX_HOME:-$HOME/.codex}/sessions"
if [ -d "$sessions" ]; then
  for f in $(find "$sessions" -name '*.jsonl' -mtime -14 2>/dev/null | xargs ls -t 2>/dev/null | head -30); do
    line=$(grep -h '"rate_limits":{' "$f" 2>/dev/null | tail -1)
    if [ -n "$line" ]; then
      printf '{"snapshot":%s}\n' "$line"
      exit 0
    fi
  done
fi

exit 1
