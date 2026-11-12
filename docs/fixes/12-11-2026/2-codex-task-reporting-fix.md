<!--
Transcribed from "2. codex-task-reporting-fix.pdf" (3 phone photos of
`ranch-codex-task-reporting-fix-plan.md` open in an editor on a Windows machine).
Source line numbers ran 1-159. Editor ligatures were written as ASCII (`=>`, `===`).
-->

# Fix plan: Codex sessions can't report tasks to the Ranch panel

Repo: `Ramanan-Bala/herdr-ranch` (local clone: `%TEMP%\opencode\herdr-ranch`, HEAD `bd639c6`)
Date: 2026-11-12

---

## 1. Problem

In a Codex tab (e.g. "Write testing tasks"), the Ranch panel never shows a task list.
Claude and OpenCode tabs work.

## 2. Root cause

| Fact | Evidence |
|---|---|
| Ranch hooks for Codex **are installed and running** | `ranch-tasks status --json` -> codex `installed`; the Codex rollout contains the injected "Ranch (mandatory): … with update_plan" text; store files `~/.herdr/ranch/tasks/terminals/t5n.json` and `sessions/01a1cbda-….json` exist |
| Ranch reads Codex tasks **only** from the `update_plan` tool | `adapters/codex.js:108` - `payload.tool_name === "update_plan" ? payload.tool_input?.plan : null` |
| Codex CLI **0.167.1 no longer exposes `update_plan`** | Live session tools: `create_goal`, `get_goal`, `update_goal`, `exec_command`, … ; `codex exec --disable goals` still lists no `update_plan`; `codex features list` has no flag that brings it back |

So Codex obeys the hook reminder, can't find `update_plan`, falls back to `create_goal`, and Ranch ignores it.

### Secondary issues found

1. **PR detection likely broken for Codex.** Hook matcher is `update_plan|Bash|shell` (`adapters/install.js:24`) and `lib/prs.js` reads `tool_input.command`. Codex now runs commands with `exec_command`, whose input is `{ "cmd": "..." }`.
2. **Hook-trust status can't detect "needs approval".** `codexTrustState` (`adapters/install.js` ~L930) parses a `[hooks.state]` table with `event:group:hook` keys. Codex 0.167 writes
   `["hooks"."state".'C:\…\hooks.json:session_start:1:0']` tables with `trusted_hash`.
3. **Any Codex run inside a Herdr terminal takes over that terminal's panel.** A throwaway `codex exec` started from an OpenCode terminal (inherits `HC_TERMINAL_ID`) re-pointed that terminal's store to the Codex session and the OpenCode tasks disappeared until the next `todowrite`.

---

## 3. Options considered

| Option | Result | Cost | Verdict |
|---|---|---|---|
| **A. `ranch-tasks plan` command** that Codex runs via `exec_command` | Full multi-task list, same as Claude/OpenCode | ~60 lines + tests | **Chosen** |
| B. Map `create_goal` / `update_goal` to one task | Only 1 task visible at a time; forcing goals every message changes Codex behaviour (goals are long-running objectives with budgets) | ~20 lines | Rejected |
| C. Pin an older Codex that still has `update_plan` | No code change, lose newer Codex features, version unknown | none | Rejected |

`update_plan` support stays in place, so older Codex versions keep working (backward compatible).

---

## 4. Design (Option A)

### 4.1 New CLI subcommand

```
ranch-tasks plan "<status>: <title>" ["<status>: <title>" ...]
```

| Prefix | Status |
|---|---|
| `todo:` | `pending` |
| `doing:` | `in_progress` |
| `done:` | `completed` |
| `skip:` | `cancelled` |

Example (one argument per task, works the same in PowerShell, cmd and sh - no JSON quoting):

```powershell
node "C:/Users/LH719EC/.herdr/ranch/bin/ranch-tasks.js" plan "done: Read the test suite" "doing: Write unit tests for parser" "todo: Run npm test"
```

Each call **replaces** the whole list (same semantics as `update_plan`).

### 4.2 Behaviour

1. Requires `HC_TERMINAL_ID`; otherwise print `ranch: not inside Herdr` and exit 1.
2. **Guard:** read `tasks/terminals/<id>.json`; refuse (exit 1, message) unless the terminal's agent is `codex`. Prevents clobbering a Claude/OpenCode terminal.
3. Parse args -> `[{ step, status }]`. Reject empty titles / unknown prefixes with a clear error (exit 1) so the model retries.
4. Reuse the existing reducer - no new store logic:
   ```js
   updateStore("codex", (store) => applyCodex(store, {
     hook_event_name: "PostToolUse", tool_name: "update_plan", tool_input: { plan },
   }));
   ```
   Locking, session files, and Stop-hook miss detection (`missed_turns`) all keep working because the task fingerprint changes.
5. Print one short confirmation for the model, e.g. `ranch: 3 tasks (1 doing, 1 done, 1 todo)`. (Unlike hook subcommands, output is fine here - it's a normal command.)

### 4.3 Files to change

| File | Change |
|---|---|
| `adapters/cli.js` | Add `plan` subcommand (+ USAGE string) per 4.2 |
| `adapters/instructions.js` | `TOOL.codex` and `reminderFor` codex text -> the `ranch-tasks plan` command with the **absolute, per-OS command** (use `lib/tasks-command.js` `tasksCommand(home, ["plan"])`); keep a note "or `update_plan` if you have it" |
| `adapters/install.js` | `CODEX_MATCHERS.PostToolUse` -> `update_plan\|Bash\|shell\|exec_command`; fix `codexTrustState` to read the new `"hooks"."state"` tables (`trusted_hash` per `hooks.json:<event>:<group>:<hook>` key) |
| `lib/prs.js` (+ `scripts/sync-lib.sh` copies into mods) | `detectCreatedPr`: also read `tool_input.cmd` (string) |
| `adapters/doctor.js` | Doctor's synthetic Codex check should exercise the `plan` path too |
| `RECIPE.md` | Document the new command and the Codex 0.167+ change |
| `test/fixtures/codex-exec-command.json` | New fixture: real `exec_command` PostToolUse payload (captured in step 0) |
| `test/adapters.test.js`, `test/install.test.js`, `test/prs.test.js`, `test/tasks-command.test.js` | Tests listed in §6 |

### 4.4 Sandbox note

The command writes to `~/.herdr/ranch/tasks`. Codex in `workspace-write` sandbox may block writes outside the workspace. Current config (`sandbox = "elevated"`, YOLO) is fine. For sandboxed setups, `install` should add `~/.herdr/ranch` to `sandbox_workspace_write.writable_roots` in `~/.codex/config.toml` (or RECIPE documents it).

---

## 5. Implementation steps

0. **Capture a real payload (no code change).** Add a temporary PostToolUse hook in `~/.codex/hooks.json` that writes stdin to a file, run one `exec_command` in Codex, confirm `tool_name` (`exec_command` vs `Bash`) and the input shape (`tool_input.cmd`). Save as fixture, remove the temp hook.
1. Branch: `git switch -c fix/codex-plan-command`.
2. `adapters/cli.js` - `plan` subcommand with guard + parser (§4.2).
3. `adapters/instructions.js` - new Codex wording + reminder.
4. `adapters/install.js` - matcher + `codexTrustState` fix.
5. `lib/prs.js` - read `tool_input.cmd`; `npm run sync` to refresh mod `lib/` copies.
6. Tests (§6), `npm run verify`.
7. Reinstall locally: `node bin/ranch-tasks install --yes` (rewrites `~/.codex/AGENTS.md` block + hooks; backups in `~/.herdr/ranch/backups`).
8. Approve the changed hooks in Codex if it asks (hooks are hash-trusted).
9. Manual check (§7), then open a PR for review - don't push to `main` directly.

---

## 6. Tests

| Test | Expectation |
|---|---|
| `plan` parses `todo/doing/done/skip` prefixes | Correct statuses, ids `1..n`, order kept |
| `plan` with bad prefix / empty title | Exit 1, nothing written |
| `plan` when terminal agent is `claude-code`/`opencode` | Exit 1, store unchanged (guard) |
| `plan` without `HC_TERMINAL_ID` | Exit 1, nothing written |
| `plan` then Stop hook | `missed_turns` not incremented |
| `update_plan` fixture still works | Existing test stays green (old Codex) |
| `detectCreatedPr` with `exec_command` / `tool_input.cmd` running `gh pr create` | PR recorded |
| `codexTrustState` with new `"hooks"."state"` format | Reports trusted / needs approval correctly |
| `reminderFor("codex", …)` | Mentions the absolute `ranch-tasks plan` command, per OS |

---

## 7. Manual verification

1. Open a fresh Codex tab in Herdr (Ranch layout).
2. Ask anything multi-step. Codex should run `ranch-tasks plan …` first.
3. Ranch panel shows the list; statuses update as Codex re-runs the command; all completed at the end.
4. `node ~/.herdr/ranch/bin/ranch-tasks.js doctor` -> ok.
5. In an OpenCode/Claude terminal, run the `plan` command by hand -> refused, panel unchanged.
6. Optional: `gh pr create` from Codex -> PR appears in the session panel.

---

## 8. Risks and rollback

| Risk | Mitigation |
|---|---|
| Model ignores the command and keeps using goals | Reminder text names the exact command; Stop hook `missed_turns` re-nudges next turn |
| Codex renames tools again | `update_plan` path kept; `plan` command is independent of Codex tool names |
| Sandbox blocks writes | §4.4 writable root |
| Reinstall restores old backups over newer edits | Use `install` (merges), not `uninstall` + restore |

**Rollback:** `node ~/.herdr/ranch/bin/ranch-tasks.js uninstall --yes`, then reinstall from the previous commit (`bd639c6`).

---

## 9. Out of scope (not doing now)

- Showing Codex goals in the panel (Option B).
- Stopping `codex exec` (non-interactive) runs from taking over a terminal's panel (secondary issue 3). Possible later: skip store updates when the SessionStart payload marks a non-interactive `exec` source.
