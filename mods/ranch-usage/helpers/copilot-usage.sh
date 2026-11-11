#!/bin/sh
# Prints GitHub Copilot's usage limits (one JSON object) and exits.
#
# Runs `gh api /copilot_internal/user`; gh authenticates itself. This script
# reads no tokens or credential files.
#
# Exit: 0 = printed the reply, 127 = gh not found, 1 = gh failed.
# Override the binary with HERDR_USAGE_GH_BIN.

GH=$(command -v "${HERDR_USAGE_GH_BIN:-gh}" 2>/dev/null) || exit 127

out=$("$GH" api /copilot_internal/user 2>/dev/null) || exit 1
printf '%s\n' "$out"
