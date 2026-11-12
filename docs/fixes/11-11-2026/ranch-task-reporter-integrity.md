# Ranch task reporter: integrity, consistency, PR card and navigation check

Date: 2026-11-11. Machine: Windows, Herdr layout `ranch`, ranch clone `6662a24` + my local installer patch.
Scope: analysis only. No ranch code was changed during this check.

## Summary

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| I1 | Claude TaskCreate | Wrong task id stored; TaskUpdate never matches; tasks stuck `pending` | High | Confirmed (live + repro) |
| I2 | Navigation | Task list does not change when you switch to another tab in the same space with the same folder | High | Confirmed (code + live layout) |
| I3 | PR card | No PR card when the tab has no agent | Medium | Confirmed (code) |
| I4 | PR card | PR is looked up only from the pane folder's checked-out branch; PRs made in other repos/worktrees (sub-agents) never show | Medium | Confirmed (live) |
| I5 | PR card | A new PR or new CI result can take up to 2 minutes to appear | Medium | Confirmed (code) |
| I6 | PR card | gh errors (auth, SSO, timeout) are hidden; looks the same as "no PR" | Low | Confirmed (code) |
| I7 | PR card | After switching tabs, the old tab's PR stays visible until gh answers; first lookup uses the old branch | Low | Confirmed (code) |
| I8 | Store writes | Parallel hooks: `EPERM` on rename, update lost, `.tmp` file left behind | Medium | Confirmed (errors.log) |
| I9 | Store writes | Lock waits 2 s then writes without the lock; OpenCode plugin never locks | Medium | Confirmed (code) |
| I10 | Identity | Store keeps the old `agent` label when a terminal id is reused (`t5b` shows `claude-code`, is OpenCode) | Medium | Confirmed (live) |
| I11 | Codex | Ranch Codex hooks are not trusted yet; `status` still says `installed` | Medium | Confirmed (config.toml) |
| I12 | Claude | `session.id` is null in live store | Low | Confirmed (live) |
| I13 | OpenCode | Task ids are empty strings | Low | Confirmed (live) |
| I14 | Claude hooks | `PreToolUse` with no matcher starts node on every tool call | Low | Confirmed (settings.json) |

What is fine:

- Installed files match the clone byte-for-byte (sha1): `~/.herdr/ranch/adapters/*`, `lib/tasks.js`, `bin/ranch-tasks.js`, OpenCode plugin, all 9 `ranch-*` mods. Only difference: my Windows patch in `adapters/install.js` (logged in `ranch-fixes.md`).
- Hooks are present once per event, no duplicates, no backslash commands, no old `todos.mjs` hooks left.
- Instruction blocks (`~/.claude/CLAUDE.md` → `RANCH.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`) have matching begin/end markers.
- `install.json` manifest is correct (it did add `experimental.todo` to `opencode.json`; my earlier note that it was already there was wrong).
- OpenCode store `t55.json` matches this session's todo list exactly.
- Smoke test (temp `RANCH_HOME`, fake terminal): Claude `TodoWrite` and Codex `update_plan` are stored correctly; no errors.

---

## I1. Claude TaskCreate: wrong id, updates lost (High)

Evidence (terminal `t4n`, Claude transcript `0ca6c8b3-...jsonl`):

| Time (UTC) | Claude did | Ranch store shows |
|---|---|---|
| 14:15:28 | TaskCreate → Task #9 | id `"1"`, pending |
| 14:15:42 | TaskUpdate 9 → in_progress | still pending |
| 14:16:30 | TaskUpdate 9 → completed, 7 → completed | still pending |
| 14:17:59 | TaskCreate → Task #10 | id `"2"`, pending |
| 14:18:05 | TaskUpdate 10 → completed | still pending |

Result: the panel shows 2 open tasks; the real state is 0 open.

Cause: `adapters/claude.js` ~line 85 reads the new id with the regex `/Task #(\S+) created successfully/` on `JSON.stringify(tool_response)`. This Claude version returns a structured object:

```json
{ "task": { "id": "9", "subject": "Push branch and open PR (no ticket)", "description": "..." } }
```

The regex does not match, so it falls back to `tasks.length + 1`. Later `TaskUpdate` uses `taskId: "9"`, finds nothing, and is ignored (~lines 99-118).

Repro: `AppData/Local/Temp/opencode/ranch-smoke.mjs` (temp home, fake terminal) gives `1:pending:Push branch` after create + two updates.

Fix (`adapters/claude.js`):

```js
const resp = payload.tool_response;
const id =
  resp?.task?.id ??                                                        // current Claude shape
  /Task #(\S+) created successfully/.exec(JSON.stringify(resp ?? ""))?.[1] ?? // old text shape
  String(store.tasks.length + 1);
```

And in TaskUpdate, if the id is not found, do not drop silently: add the task when `subject` exists, else write a `hookError("TaskUpdate: unknown id ...")` so it shows in `errors.log`.

Note: `~/.claude/tasks/<session>/` only holds `.highwatermark` and `.lock` in this Claude version, so "read Claude's task files" (suggested earlier in `ranch-fixes.md` F6) will not work. Use `tool_response.task.id` now; the transcript is the fallback source of truth.

---

## I2. Task list not updating when you move between tabs in the same space (High)

Your report is correct.

Cause: `mods/ranch-session/main.js` `pump()` (lines 452-468) only reloads tasks when this key changes:

```js
const key = `${s.machine ?? ""}|${s.cwd ?? ""}`;   // machine + folder only
if (key !== this.sessionKey) { ... this.loadTasks(cx) ... }
```

The key has no tab and no agent. Two tabs in one space usually have the same folder. Moving between them keeps the key the same, so `loadTasks()` is never called and the old agent's list stays on screen.

Live example: `t4n` (Claude) and `t5b` (OpenCode) are both in space `raptor-forms-render` with folder `C:\Raptor\raptor-forms-render`. Switching between them keeps showing the first one's tasks.

It "fixes itself" only when any agent writes any store file: the folder watcher (lines 160-175) calls `loadTasks()`, which then reads the newly focused agent. That is why it looks random.

Same root cause also skips: sub-agent cards (`loadSubTasks`), `filesOpen`/`ciOpen` reset, and the push state reset.

Fix (`pump()`): compare the agent key on every tick, outside the folder check:

```js
const key = `${s.machine ?? ""}|${s.cwd ?? ""}`;
if (key !== this.sessionKey) { /* existing git/pr/reset code, without the task part */ }
const tkey = s.chosen ? `${s.chosen.address}@${s.machine ?? ""}` : null;
if (tkey !== this.tasks.key && !this.tasksBusy) this.loadTasks(cx);
```

Also in `loadTasks()`: after the `await readTextFile(...)`, re-check that `this.session().chosen?.address` is still the same agent; if not, drop the result and load again. Otherwise a slow read can still write the wrong list.

---

## I3. PR card hidden in tabs without an agent (Medium)

`render()` lines 515-520: when the tab has no agent it shows the git card and returns before the PR card (lines 530-537). A plain PowerShell tab on a PR branch (for example `t57` in `raptor-forms-profile-api`, branch `fix/studio-table-format-dedupe`, PR #1292 open) shows git but no PR.

Fix: render `this.prCard(t)` (and the "GitHub CLI not found" line) in the no-agent branch too.

## I4. PR only from the pane's folder and current branch (Medium)

`refreshPr()` (lines 401-449) runs `gh pr view <branch>` in the chosen pane's `cwd`, with the branch from `git.summary`. It returns no PR when the branch is the default branch.

Live example: `t4n` works in `raptor-forms-render` on `master`. Its sub-agent `t56` made PR #1292 in `raptor-forms-profile-api`. Session Details for `t4n` shows no PR, ever. `gh` itself works fine here (`gh 2.100.0`, `gh pr view` returns full JSON for #1292).

Fix options (pick one):
- Simple: also show a small PR card per sub-agent, using the sub-agent terminal's own `cwd`.
- Better: let adapters record PR URLs the agent created (Claude/Codex `PostToolUse` on `Bash` where command contains `gh pr create`, read the URL from output) into the store as `prs: [...]`, and show those in addition to the branch PR.

## I5. New PR / CI results show late (Medium)

- `prSec` default is 120 (`lib/settings.js` line 26). `pump()` (lines 485-488) refreshes the PR only on branch change or every 120 s.
- A PR created by the agent with `gh pr create` does not change the branch, and the repo watcher only sets `git.dirty`, not `pr.dirty`. So a "no PR" result is kept for up to 2 minutes.
- Running CI checks also refresh only every 2 minutes.

Fix: set `this.pr.dirty = true` when the git watcher fires (cheap: one gh call, already de-duplicated by `pr.busy`), and poll faster (for example 20 s) while `pr.checks.pending > 0`.

## I6. gh failures look like "no PR" (Low)

Lines 437-444 set `failed = true` but `render()` only prints a message for `"missing"`. Auth expired, SAML SSO not authorized, network errors and the 15 s timeout all look like "this branch has no PR".

Fix: show a quiet one-line note for `failed === true` with the first line of `stderr` (for example "gh: authentication required").

## I7. Old PR shown after switching tabs (Low)

- `prCard()` (line 1071) draws `this.pr.parsed` without checking that `this.pr.key` belongs to the current tab, so the previous tab's PR stays until gh answers (1-5 s).
- On a folder change `pump()` calls `refreshPr()` in the same tick as `refreshGit()`, so the first lookup uses the old branch in the new folder. It corrects itself after git finishes.

Fix: in `pump()`, when the session key changes, clear `this.pr.parsed` and skip `refreshPr()` until `refreshGit()` has returned for the new folder (`this.git.key` matches).

---

## I8. Parallel hooks lose updates on Windows (Medium)

`~/.herdr/ranch/logs/errors.log`:

```
2026-11-11T13:47:48Z EPERM: operation not permitted, rename 't4n.json.tmp-32616' -> 't4n.json'
  at writeStore (store.js:39) <- updateStore (store.js:88) <- runHook (cli.js:64)
```

Claude ran `TaskUpdate 6 completed` and `TaskUpdate 7 in_progress` in parallel. On Windows `rename` over a file that another process has open fails with `EPERM`. That update was lost, and `tasks/t4n.json.tmp-32616` was left behind.

Fix (`adapters/store.js` `writeStore`, and the same in `opencode-plugin.js` `saveStore`):

```js
for (let i = 0; i < 10; i++) {
  try { renameSync(tmp, path); return; }
  catch (e) { if (!["EPERM", "EBUSY", "EACCES"].includes(e.code) || i === 9) { rmSync(tmp, { force: true }); throw e; } }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
}
```

Also: `ranch-tasks gc` should delete `*.json.tmp-*` older than 1 minute.

## I9. Lock is not a real lock (Medium)

- `store.js` `takeLock()` waits up to 2 s, then returns `null`, and `updateStore()` writes anyway.
- `opencode-plugin.js` `saveStore()` (lines 97-103) never takes the lock.

Fix: if the lock is not taken, retry the whole read-modify-write once more, then log `hookError` instead of writing blind. Use the same `updateStore()` in the OpenCode plugin.

## I10. Wrong agent label after terminal id reuse (Medium)

`t5b.json` says `agent: "claude-code"`, but `hc ls` shows `t5b` is OpenCode (session `ses_e351...`, an OpenCode id). `normalizeStore()` / `readStore()` keep the old `agent` field and never overwrite it.

Fix: every adapter sets `agent` on each write; when the stored `agent` or `session.id` differs from the incoming one, start a fresh store (drop old tasks). Same as `ranch-fixes.md` F4.

## I11. Codex hooks not approved, but status says "installed" (Medium)

`~/.codex/config.toml` `[hooks.state]` only trusts the old hook positions (`session_start:0:0`, `stop:0:0`, `post_tool_use:0:0`, `stop:0:1`, `user_prompt_submit:0:0`). The ranch hooks moved the positions, so they are untrusted and do not run. Codex sub-agent `t56` has no store file.

- Action for you: in Codex run `/hooks` and approve the ranch hooks once.
- Fix in ranch: `ranch-tasks status` should read `[hooks.state]` and report `codex: "needs approval"`; delete stale trust entries on install.

## I12. Claude `session.id` is null (Low)

`t4n.json` has `session.id: null`. The smoke test (with `session_id` in the payload) stores it fine. In the live session, SessionStart ran before ranch was installed, and other events do not set it.

Fix: `claude.js` sets `session.id` from `payload.session_id` on every event, not only SessionStart.

## I13. OpenCode task ids are empty (Low)

`t55.json` / `t5b.json` tasks have `id: ""`. OpenCode todos have no id. The panel can't track a task across edits.

Fix: id = index + short hash of the title when `id` is missing (same as `ranch-fixes.md` F8).

## I14. PreToolUse hook on every tool (Low)

Claude `PreToolUse` has no matcher, so every tool call starts `node ranch-tasks.js claude` (~50-100 ms each on Windows). It only updates activity.

Fix: drop it, or limit to a matcher; activity is already updated by `PostToolUse`, `UserPromptSubmit`, `Stop`, `Notification`.

---

## Fix order

1. I1 (Claude ids) and I2 (navigation): biggest wrong-on-screen problems, both one small change.
2. I8 + I9 (safe writes): stops lost updates.
3. I11: approve Codex hooks now (`/hooks`), then fix `status`.
4. I3-I7 (PR card).
5. I10, I12, I13, I14.

## Files referenced

- Installed adapters: `~/.herdr/ranch/adapters/{claude.js,codex.js,cli.js,store.js,opencode-plugin.js,install.js}`
- Session panel: `~/.config/herdr-app/mods/ranch-session/main.js`, `lib/git.js`, `lib/settings.js`
- Stores: `~/.herdr/ranch/tasks/*.json`, log: `~/.herdr/ranch/logs/errors.log`
- Repro script: `~/AppData/Local/Temp/opencode/ranch-smoke.mjs`
- Related docs: `Downloads/ranch-fixes.md`, `Downloads/ranch-tasks-windows-install-plan.md`, `Downloads/ranch-task-reporting-improvements.md`
