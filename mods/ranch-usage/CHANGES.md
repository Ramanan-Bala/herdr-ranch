# Changes from Orca's usage-limits

This mod is adapted from Orca's [`usage-limits`](https://github.com/VladTemp27/herdr-orca) (Apache-2.0); its licence and NOTICE are at `licenses/herdr-orca/`. Per Apache-2.0 §4b, these are the modifications:

- Renamed to `ranch-usage`; the shared-state keys are `ranch-usage.state`, `ranch-usage.prefs` and `ranch-usage.refresh`.
- Orca's pure helpers moved from `lib/` to `usage/` — Ranch's `scripts/sync-lib.sh` copies its own `lib/*.js` into every `mods/ranch-*/lib/` and would overwrite them there.
- Restyled for Ranch: theme tokens only, Ranch text sizes (11.5px in the bar, 12px in the panel), bar background `t.chrome`, and level colours ok → `t.foreground` (dim for "—"), warn (≥70% used) → `t.ansi3`, hot (≥90% used) → `t.ansi1`. Agents that are not installed do not appear in the bar at all.
- Added a Copilot provider: `providers/copilot.js` plus `helpers/copilot-usage.sh`, which runs `gh api /copilot_internal/user` and parses `quota_snapshots` (premium, chat, completions and unknown ids; unlimited snapshots skipped; reset date from `quota_reset_date[_utc]`, the month paced as 30 days).
- Added `usage/unreported.js` and a "Not reported by its CLI" section in the hover panel: agents whose usage their CLI cannot report are listed with an "Open usage ↗" browser link when their binary is on PATH (checked once an hour). First entry: OpenCode Go.
- Updated for Ranch's status row (`layouts/ranch.json`): the meter sits left of the shipped `workspace-status` block, with `align: "left"` and `showRemaining: false` props from the layout.
