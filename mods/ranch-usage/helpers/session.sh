#!/bin/sh
# Prints one line of numbers about the session a process is running, and exits:
#   claude: tokens=N calls=N compactions=N [lastTrigger=auto lastPre=N lastPost=N]
#   codex:  tokens=N window=N calls=N
#
# Usage: session.sh claude|codex <pid of the agent in the terminal>
#
# Session files hold the whole conversation. Only numbers leave this script.
# Text in them is JSON-escaped, so \"type\" can't match the "type" looked for here.
# Calls are the person's messages: Claude's "last-prompt" marker repeats within a turn.
#
# Exit: 0 = printed, 1 = no session found for that process (never a guess).
# Claude's files follow CLAUDE_CONFIG_DIR.

app=$1
pid=$2
case "$pid" in '' | *[!0-9]*) exit 1 ;; esac

# The number after "key": in a line, 0 if there is none.
NUM='function num(s, k,   p) {
  p = "\"" k "\":[0-9]+"
  if (!match(s, p)) return 0
  return substr(s, RSTART + length(k) + 3, RLENGTH - length(k) - 3) + 0
}'

claude() {
  dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  [ -f "$dir/sessions/$pid.json" ] || exit 1
  id=$(sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' "$dir/sessions/$pid.json")
  case "$id" in '' | *[!0-9a-zA-Z-]*) exit 1 ;; esac
  for file in "$dir"/projects/*/"$id".jsonl; do
    [ -f "$file" ] || exit 1
    awk "$NUM"'
      /"type":"user"/ && /"isSidechain":false/ && !/"isMeta":true/ && !/"isCompactSummary":true/ && !/"type":"tool_result"/ { calls++ }
      /"subtype":"compact_boundary"/ {
        compactions++
        pre = num($0, "preTokens"); post = num($0, "postTokens"); tokens = post
        trigger = match($0, /"trigger":"[a-z]+"/) ? substr($0, RSTART + 11, RLENGTH - 12) : ""
      }
      /"type":"assistant"/ && /"isSidechain":false/ {
        u = index($0, "\"usage\":{")
        if (u) {
          s = substr($0, u)
          # With server tools, usage adds up every request of the turn: the last one is the context.
          i = index(s, "\"iterations\":[")
          if (i) {
            t = substr(s, i)
            while ((i = index(t, "{\"input_tokens\":")) > 0) { s = substr(t, i); t = substr(t, i + 1) }
          }
          n = num(s, "input_tokens") + num(s, "cache_creation_input_tokens") + num(s, "cache_read_input_tokens")
          if (n > 0) tokens = n
        }
      }
      END {
        if (!tokens) exit 1
        printf "tokens=%d calls=%d compactions=%d", tokens, calls, compactions
        if (compactions) printf " lastTrigger=%s lastPre=%d lastPost=%d", trigger, pre, post
        printf "\n"
      }' "$file"
    exit $?
  done
}

# One app-server can hold several sessions open: the live one was written last.
newest_rollout() {
  lsof -nP -Fn -p "$1" 2>/dev/null | sed -n 's/^n//p' | grep '/sessions/.*/rollout-.*\.jsonl$' | {
    newest=
    while IFS= read -r f; do
      if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest=$f; fi
    done
    printf '%s' "$newest"
  }
}

# The terminal's codex runs a child app-server, and that holds the session open.
codex() {
  for kid in $(pgrep -P "$pid"); do
    file=$(newest_rollout "$kid")
    [ -n "$file" ] || continue
    awk "$NUM"'
      /"type":"task_started"/ { calls++ }
      /"type":"token_count"/ {
        u = index($0, "\"last_token_usage\":{")
        if (u) { tokens = num(substr($0, u), "total_tokens"); window = num($0, "model_context_window") }
      }
      END {
        if (!tokens) exit 1
        printf "tokens=%d window=%d calls=%d\n", tokens, window, calls
      }' "$file"
    exit $?
  done
  exit 1
}

case "$app" in
  claude) claude ;;
  codex) codex ;;
  *) exit 1 ;;
esac
