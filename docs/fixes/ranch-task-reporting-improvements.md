# Ranch task reporting: overall improvements for accuracy

Companion to `ranch-fixes.md` (bug list F1-F14) and `ranch-tasks-windows-install-plan.md`.
Those documents fix what is broken. This one covers what to change so the Ranch panel
shows **what each agent is actually doing, right now**, as often as possible.

---

## 1. What "accurate" means

When you look at a terminal in the Ranch panel, the list you see should:

| # | Property | Fails today when |
|---|---|---|
| A1 | belong to the agent running in that terminal | a terminal id is reused after herdr-core restarts (F4) |
| A2 | match the agent's own task list item by item | Claude `TaskCreate` id parsing misses (F6), OpenCode drops cancelled tasks (F7) |
| A3 | be current, not stale | lists are never cleaned up (F5), agent idle with `in_progress` items |
| A4 | exist at all | the agent never called the todo tool, hooks not installed/approved, Windows exec fails (F2/F3) |
| A5 | follow the session | a session resumed in another terminal shows nothing there |
| A6 | include sub-agent work | the child terminal or session is not linked to its parent |

Every proposal below names the property it fixes.

---

## 2. Pipeline today (where errors enter)

```
agent tool call --> hook / plugin --> adapter normalizes --> ~/.herdr/ranch/tasks/<terminal>.json --> ranch-session reads + renders
  (A4: agent forgets)  (A4: not installed,   (A2: id parsing,      (A1: keyed by terminal only,          (A3: no staleness rules,
                        Windows exec)         cancelled dropped)    A5: no session key)                  A6: 3 s throttle)
```

---

## 3. Improvements

### 3.1 Capture: read the agent's real source of truth (A2)

| Agent | Today | Better |
|---|---|---|
| Claude `TodoWrite` | full list from tool input | keep |
| Claude `TaskCreate`/`TaskUpdate` | regex `Task #(\S+) created successfully` on the reply text | after each event, read `~/.claude/tasks/<session_id>/*.json` and rebuild the full list (our old `todos.mjs` did this). Keep the regex only as a fallback |
| Codex `update_plan` | full plan from hook payload | keep; also read on `Stop` so the final state is never missed |
| OpenCode `todowrite` | tool args from `tool.execute.after` | also listen to `todo.updated` events with the full list. Treat the event as the authority because it reflects what OpenCode stored, not what the model sent |

Rule: **always store the full list, never apply deltas.** A delta that is lost (failed hook,
crash, parallel hooks) corrupts the list until the next full write. A full rebuild repairs
itself on the next event.

> Transcriber note: `ranch-task-reporter-integrity.md` I1 found that `~/.claude/tasks/<session>/` only holds `.highwatermark` and `.lock` in the current Claude version; use `tool_response.task.id` as the primary source.

### 3.2 Normalization: keep information, don't invent it (A2)

- **Keep `cancelled`** as its own status (F7). Show it struck through, and leave it out of the
  "N of M" totals. Dropping it makes the counts jump, and you lose sight of work the agent abandoned.
- **Stable ids** (F8). When the agent gives no id, derive one from `sha1(content)`, plus an index
  for duplicates. Then the UI can animate status changes instead of re-rendering everything,
  and diffs between writes become meaningful.
- **Write `active_form` only when the agent sends it.** Never copy `content` into it, so the UI
  can tell when the agent sent no progress wording.
- **Strict schema validation** (`schema: 1`). Reject anything malformed and log it to a
  `.error` file. Don't render half-parsed data.

### 3.3 Identity: who wrote this list (A1, A5)

Store **who wrote it**, not just where:

```json
{
  "schema": 2,
  "terminal": "t55",
  "terminal_started_at": "2026-11-11T18:59:16Z",
  "agent": { "app": "opencode", "session": "ses_...", "pid": 12345 },
  "seq": 42,
  "updated_at": "...",
  "tasks": [ ... ]
}
```

- **Terminal-id reuse (A1):** the reader shows a list only if the terminal is live, its
  `started_at` matches the stored value, and the detected agent app matches (`hc get --json`).
  This is our old `join()` guard, made stronger with the start time.
- **Session-keyed storage (A5):** write to `sessions/<session>.json`, and keep
  `terminals/<terminal>.json` as a pointer. When a session resumes in another terminal, the
  first hook or plugin event re-points that terminal (our old `claim()`). The list follows
  the conversation, not the window.
- **Out-of-order writes:** Claude can run hooks in parallel. Add a monotonic `seq`
  (or `updated_at` with ms) and have the writer refuse to overwrite a newer `seq`.

### 3.4 Storage: safe writes on every OS (A3, A4)

- Write to a temp file, `fsync`, then rename. On Windows, retry the rename about 5 times with
  a short back-off on `EPERM`/`EBUSY` (antivirus and indexers hold files) (F14).
- Use a per-file lock (`<file>.lock` created with `wx`, stale after 5 s) so two hooks can't
  interleave a read-modify-write.
- Keep the last good copy (`<file>.bak`). A reader that hits invalid JSON falls back to it
  instead of showing nothing.

### 3.5 Lifecycle: clear what is no longer true (A3)

Automatic rules, run by the reader (no cron needed), taken from our old `stale()`:

| Condition | Action |
|---|---|
| terminal gone for more than 2 min | delete the list |
| agent process exited, or a new agent started in the terminal after `updated_at` | hide the list (archive) |
| all items done/cancelled and agent idle for more than 10 min | fade, then remove |
| agent idle (Herdr status `idle`/`done`) but an item is still `in_progress` | **flag** the item ("agent stopped while working on this"). Don't silently mark it done |
| session file untouched for 14 days | prune (`ranch-tasks gc` runs this automatically on install and on panel start) |

The `idle + in_progress` flag is the single biggest accuracy signal: it shows exactly when
the list and reality have diverged.

### 3.6 Display: show the right slice, quickly (A3, A6)

- **Trailing-edge throttle** for sub-agent stores. The 3 s throttle must always do one final
  read after the burst, otherwise the last update before an agent stops is lost.
- **Debounce `watchFolder`** at about 150 ms, then re-read only the changed file.
- Keep the `in_progress` row visible when the list is longer than the viewport (our old `visible()`).
- Show freshness: "updated 4 s ago". Grey out when older than about 2 min while the agent is busy.
- Nest sub-agents under their parent by `parent_terminal` / `parent_session`, not by name heuristics.

### 3.7 Compliance: get agents to report at all (A4)

Today three sources nag the agent (the ranch plugin `TASK_RULE`, the AGENTS.md block, and our
old reminder, now removed). They cost tokens and still don't guarantee a list.

Better:

1. **One instruction source**: the AGENTS.md / CLAUDE.md block only (F13).
2. **Conditional nudge**: on `UserPromptSubmit` / OpenCode `chat.message`, inject the reminder
   **only if** the session has no list yet, or the list was not updated during the previous turn.
3. **Detect misses**: on `Stop`, if the turn used write/edit/shell tools and the list did not
   change, record `missed_turns++` and show a small "no task updates" badge on the terminal.
   This turns silent failures into visible ones.
4. **Close-out check**: on `Stop`, if items are still `in_progress`, inject (Claude
   `Stop` hook `decision: block` with a reason, used sparingly) or flag them per 3.5.

### 3.8 Health: prove the pipeline works (A4)

- `ranch-tasks doctor`:
  - checks node, the hook command path, that the hook is executable on this OS, Codex hook approval, and OpenCode `experimental.todo`;
  - then **fires a synthetic event through each installed adapter** and confirms the store file appears.
- Keep a per-agent `last_event_at` in `~/.herdr/ranch/health.json`. The Settings panel shows
  "Claude: last report 2 min ago" instead of only "installed".
- Rotate an adapter error log (`~/.herdr/ranch/logs/adapter.log`, max 1 MB). Hooks must never
  fail the agent, but failures must be visible somewhere.

### 3.9 Tests that keep it accurate

- **Golden payload fixtures** per agent and version: real hook JSON captured from Claude
  (`TodoWrite`, `TaskCreate`, `TaskUpdate`, `SessionStart`, `Stop`), Codex (`update_plan`) and
  OpenCode (`todowrite`, `todo.updated`). A format change in an agent release then fails CI
  instead of silently breaking the panel (it would catch the F6 regex).
- **Scenario tests** for the reader: terminal-id reuse, session resume in a new terminal,
  parallel hooks with out-of-order `seq`, idle with `in_progress`, cancelled items, a corrupt file.
- **Windows CI job** (see the install plan, phase 4).

---

## 4. Our side (local setup) improvements

| Item | Why |
|---|---|
| Keep `herdr-todos` plugin minimal (only the `todowrite` tool) | ranch reads it; no duplicate store or reminder |
| Drop it once OpenCode ships a native todo tool for V2 | avoid two tools of the same name |
| Remove `~/.config/herdr-core/todos.mjs` after a week of ranch working well | dead code; the backup already has it |
| Keep the shared `AGENTS.md` rule 6 ("ALWAYS track your work...") **or** the ranch block, not both | they say the same thing; trim to one |
| After any ranch update from upstream, re-check `ranch-fixes.md` §1 | the Windows installer patch is lost on reinstall |

---

## 5. How to measure improvement

Track these per day, from `health.json` and store files:

| Metric | Target |
|---|---|
| % of agent turns with a list update (when tools were used) | > 95 % |
| Lists shown for the wrong agent (A1 guard trips) | 0 shown; count the trips |
| `idle + in_progress` flags older than 10 min | trending to 0 |
| Adapter errors per day | 0 |
| Time from tool call to panel update | < 1 s |

---

## 6. Suggested order

1. Windows install plan + F2/F3 (nothing works without these).
2. Identity + `seq` + reader guards (3.3): fixes wrong-agent lists.
3. Source-of-truth capture + keep cancelled + stable ids (3.1, 3.2).
4. Lifecycle rules + `idle + in_progress` flag (3.5).
5. Health/doctor + golden fixtures (3.8, 3.9).
6. Compliance nudges + miss badge (3.7).
7. Display polish (3.6).

Steps 2-4 give most of the accuracy gain. Steps 5-6 keep it from regressing.
