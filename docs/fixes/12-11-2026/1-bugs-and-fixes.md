<!--
Transcribed from "1. bugs-and-fixes.pdf" (5 phone photos of `herdr-ranch-bugs-and-fixes.md`
open in an editor on a Windows machine). Line numbers in the source ran 1-262.
Editor ligatures were written as ASCII (`=>`, `!==`, `===`).
Where a character could not be read with certainty it is marked [?].
-->

# Herdr Ranch: Bug Report and Fixes

Date: 2026-11-12
Scope: three Ranch bugs found in the Herdr app (session details panel, sidebar, and agent tab naming).

The paths below are the **installed copies**. `install.js` copies `lib/` into each mod, so fix the Ranch source repo and reinstall. Do not patch only the installed copies.

| Area | Installed path |
|---|---|
| Hook adapters | `~/.herdr/ranch/adapters/{cli.js, claude.js, codex.js, opencode-plugin.js, store.js, instructions.js}` |
| Shared libs | `~/.herdr/ranch/lib/{prs.js, tasks.js}` (copied to `mods/ranch-*/lib/`) |
| Shared PR registry | `~/.herdr/ranch/prs.json` |
| Session details mod | `~/.config/herdr-app/mods/ranch-session/main.js` |
| Sidebar mod | `~/.config/herdr-app/mods/ranch-sidebar/main.js` |
| Agent instructions | `~/.config/agent-instructions/AGENTS.md` (included by Claude, Codex and OpenCode) |

---

## Bug 1: "PRs opened by agent in this branch" shows a PR from another repo in every tab on that branch

### Symptom

An agent working in repo A opens a PR in repo B. That PR then appears under **"PRs opened by agent in this branch"** in every tab on repo A's checkout and branch. This includes tabs and agents that had nothing to do with it.

### Expected behavior

Example: a session in **render** creates a PR in **profile-api** from branch `fix/FG-7997-studio-expr-prefix`.

| Where | Should show the PR? |
|---|---|
| The one render session whose agent ran `gh pr create` | **Yes** (its own record) |
| Other render sessions / tabs (same render branch) | **No** |
| Every profile-api session / tab on `fix/FG-7997-studio-expr-prefix` | **Yes** (shared, by the PR's own repo and head branch) |
| profile-api sessions on other branches | No |

In short: the shared registry must file a PR under **the PR's own repo and branch**. A PR made from another repo shows only in the session that created it.

### Evidence

`~/.herdr/ranch/prs.json`:

```json
"C:/Raptor/raptor-forms-render|dev/Anand/blockmerge-sbx": [
  { "url": "https://github.com/ey-fso-tax/forms-profile-api/pull/1299", "at": "2026-11-12T12:23:21Z", ... }
]
```

- The PR belongs to **`ey-fso-tax/forms-profile-api`**.
- It is filed under the **`raptor-forms-render`** checkout (origin `ey-fso-tax/forms-render`).
- Source: Claude session `3fb260d9-e0ff-4911-97c4-015fd1561930`, session cwd `C:\Raptor\raptor-forms-render`, which ran:

```bash
cd /c/Raptor/raptor-forms-profile-api && gh pr create --base master --head fix/FG-7997-studio-expr-prefix ...
```

The tool result then said `Shell cwd was reset to C:\Raptor\raptor-forms-render`, so the payload's `cwd` was still forms-render.

### Root cause

**Write side** (`adapters/cli.js` -> `recordSharedPrFromPayload`):

1. On `PostToolUse`, `detectCreatedPr(payload)` matches `gh pr create` anywhere in the command, including after `cd X &&`.
2. `repoFacts(payload.cwd)` runs `git rev-parse --show-toplevel` and `git rev-parse --abbrev-ref HEAD` in **`payload.cwd`**. That is the agent session's directory, not the directory the command actually ran in.
3. `recordSharedPr(top, branch, record)` (`store.js` ~L199) calls `addPr` keyed `top|branch` (`lib/prs.js` `prKey`).
4. Nothing checks that the PR URL's `owner/repo` belongs to that checkout. It also ignores `cd <dir> &&`, `gh -R/--repo`, `git -C`, and the tool's working dir.

**Read side** (shows it everywhere):

- `ranch-session/main.js` `recordedPrs()` (~L1562-1590) merges the per-terminal `store.prs` with `prsFor(prRegistry, this.git.top, this.git.summary.branch)`.
- `ranch-sidebar/main.js` `recordedResolved(registry, machine, top, branch, ...)` (~L252) uses the same `prsFor`.
- The registry is keyed only by `checkout|branch`, so **every** tab on that checkout and branch shows the wrong PR.

There are two stores, and they already split the way we want:

| Store | Written by | Read by | Scope |
|---|---|---|---|
| Per-session `store.prs` (`~/.herdr/ranch/tasks/sessions/<session>.json`) | `claude.js` `recordCreatedPr` ~L103-107, `codex.js` ~L50-55 | session details panel only (`recordedPrs` L1572-1578, own store + its sub-agents) | **the one session that ran it** |
| Shared registry `prs.json` (`top\|branch`) | `cli.js` `recordSharedPrFromPayload` | session details panel (L1584) **and** sidebar (`recordedResolved` L255, registry only) | **every tab on that checkout + branch** |

The per-session record is already correct: it is what keeps the PR visible in the render session that created it. Only the shared registry entry is filed under the wrong key.

### Fix

**1. Write side: file the shared record under the PR's own repo and branch (required).**
In `cli.js` `recordSharedPrFromPayload`, stop using `payload.cwd` blindly:

1. Parse the PR repo from the URL: `github.com/<owner>/<repo>/pull/<n>` -> `ey-fso-tax/forms-profile-api`.
2. Find the command's **effective directory**: a leading `cd <dir> &&` / `cd <dir>;` (resolved against `payload.cwd`, Git Bash `/c/...` -> `C:/...`), or `git -C <dir>`. Otherwise use `payload.cwd`.
3. Run `repoFacts(effectiveDir)` to get `top`, and read its remotes (`git remote -v`).
4. Use **the branch from `gh pr create --head <branch>`** when given; otherwise the effective dir's current branch.
5. Record in `prs.json` **only if** one of `top`'s remotes is the PR repo. Otherwise (e.g. `gh pr create -R owner/repo` with no local checkout found) skip the shared record. The creating session still shows it from its own store.

```js
function prRepoOf(url) {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec(url ?? "");
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

function remoteRepos(top) {
  // git remote -v lines: "origin  https://github.com/owner/repo.git (fetch)" or "git@github.com:owner/repo.git"
  return (git(["remote", "-v"], top) ?? "").split("\n")
    .map((l) => /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s/i.exec(l))
    .filter(Boolean).map((r) => `${r[1]}/${r[2]}`.toLowerCase());
}

function recordSharedPrFromPayload(payload) {
  if (payload?.hook_event_name !== "PostToolUse") return;
  const found = detectCreatedPr(payload);
  if (!found) return;
  const cmd = payload.tool_input?.command ?? "";
  const facts = repoFacts(effectiveDir(cmd, payload.cwd));       // cd <dir> && / git -C <dir>
  if (!facts || !remoteRepos(facts.top).includes(prRepoOf(found.url))) return; // not this checkout's PR
  const head = /--head[ =]("?)([^\s"]+)\1/.exec(cmd)?.[2];
  recordSharedPr(facts.top, head ?? facts.branch, { ...found, at: new Date().toISOString() });
}
```

Result for the example: the entry lands under `C:/Raptor/raptor-forms-profile-api|fix/FG-7997-studio-expr-prefix`. Every profile-api tab on that branch shows it. No render tab gets it from the registry.

**2. Keep the per-session record as is (no change).**
`claude.js` / `codex.js` keep writing the PR into the creating session's own `store.prs`. The session details panel already shows those records first. So the render session that ran the command keeps showing it, and other render sessions don't. Optional: when a record's repo differs from the checkout's, show the repo name next to it (e.g. `forms-profile-api #1299`), because the section title says "in this branch".

**3. Read side defence on registry records only (recommended).**
In `ranch-session` (`recordedPrs` L1584 loop) and `ranch-sidebar` (`recordedResolved` L255), skip **registry** records whose URL repo is not one of the checkout's remotes. Do **not** apply this filter to the session's own `store.prs` (L1572-1578), or the creating session would lose its PR. This also hides any bad entries already in `prs.json`.

Note: the sidebar reads only the registry. After the fix, the render tab's sidebar card will **not** show the profile-api PR. Only its session details panel will. If the sidebar should show it too for that one tab, have `recordedResolved` also merge that card's own terminal store `prs`.

**4. Data cleanup.**
In `~/.herdr/ranch/prs.json`, move `forms-profile-api/pull/1299` from `C:/Raptor/raptor-forms-render|dev/Anand/blockmerge-sbx` to `C:/Raptor/raptor-forms-profile-api|fix/FG-7997-studio-expr-prefix`. The render session's own store already holds its copy.

**5. Tests.**

- cwd = render, command `cd /c/Raptor/raptor-forms-profile-api && gh pr create --head X ...`, URL in profile-api -> registry key `<profile-api top>|X`, **nothing** under render.
- cwd = render, `gh pr create -R ey-fso-tax/forms-profile-api ...` (no `cd`) -> no registry record. The session store still has it.
- cwd = repo A, URL in repo A -> recorded under `A|branch` (no regression).
- Session panel: own-store record from another repo is shown. Registry record from another repo is not.

**Trade-off (alternative):** key the registry by `owner/repo|branch` instead of the local path. Then every checkout or worktree of profile-api on that branch matches, even with `-R` and no `cd`. It costs a registry format change, and both mods would need the checkout's remote repo instead of `top`. The fix above keeps the current format.

---

## Bug 2: Tab rename renames the user's focused tab, not the agent's tab

### Symptom

At session start, the agent renames "its" tab. It actually renames whichever tab the user is looking at.

### Root cause

This is an instruction bug, not a Herdr code bug. `~/.config/agent-instructions/AGENTS.md` (section **"Herdr Tab Names"**, ~L93) tells agents:

> Read its ID from `herdr-app status`, then run `herdr-app do tab.rename --id <tab-id> --name "<task title>"`.

`herdr-app status` describes the **window**: `space`, `tab`, `focused_pane`, `layout`. Its `tab` is the tab the user currently has focused. If the user has switched to another tab by the time the agent runs this, the wrong tab is renamed. It only "works" when the user happens to stay on the agent's tab.

Every agent terminal knows its own tab through herdr-core labels. Verified in this session (terminal `t6m`):

```text
hc get $env:HC_TERMINAL_ID --json
  labels.herdr.space = spf9b05fc4de3a2d3e6e539c0bffc876c2
  labels.herdr.tab   = tba61b09626b6a81036cc0d29af5fca13e   <- the agent's own tab
```

### Fix

Replace the instruction in `~/.config/agent-instructions/AGENTS.md`:

```markdown
## Herdr Tab Names

- At the start of every Claude or OpenCode session, once the opening task is clear, rename the
  tab this agent runs in (never the focused tab). Get the tab from your own terminal's labels:

    $tab = (hc get $env:HC_TERMINAL_ID --json | ConvertFrom-Json).labels.'herdr.tab'
    if ($tab) { herdr-app do tab.rename --id $tab --name "<task title>" }

- Do not use `herdr-app status` for this; it reports the user's focused tab.
- If `HC_TERMINAL_ID` is unset or the terminal has no `herdr.tab` label (for example a sub-agent
  started with `hc run`), skip renaming. Don't create or switch tabs just to rename one.
```

Notes:

- Sub-agents must not rename. They either have no tab label or share the parent's tab.
- On remote machines, app IDs are prefixed `<machine>/`. The labels are machine-local, so build the ID accordingly if the rename runs from another machine.
- Optional hardening in Herdr: an `hc tab rename --self` or `herdr-app do tab.rename --terminal <addr>` command would remove the need for agents to resolve the tab ID at all.

---

## Bug 3: Session details -> Tasks shows "no task updates" even though tasks are updating

### Symptom

The Tasks card shows the "no task updates" warning while the agent is updating its task list on every message.

### Where the badge comes from

- `ranch-session/main.js` `tasksCard` (~L1724-1728) shows the badge when `parsed.store.missed_turns > 0`.
- `adapters/instructions.js` (~L66-72) also injects a "you stopped updating tasks" reminder when `missed_turns > 0`.

`missed_turns` is incremented at the end of a turn when the task-list fingerprint is unchanged since the turn started:

| Agent | Where | Condition |
|---|---|---|
| Claude | `claude.js` ~L281-299 | `Stop`, the turn used work tools, fingerprint unchanged since `UserPromptSubmit` |
| Codex | `codex.js` ~L125-131 | `Stop`, fingerprint unchanged (**no tool-use check**) |
| OpenCode | `opencode-plugin.js` `reduceOpencode` ~L265-291 | state `done` (from `session.idle`, `session.status: idle`, `session.execution.succeeded/failed/interrupted`, mapped ~L563-568), `turn.tools` true, fingerprint unchanged since `chat.message` (~L392-401) |

### Root cause A: the counter is never reset (main bug)

`missed_turns` is initialized to `0` (`lib/tasks.js` ~L158, `opencode-plugin.js` ~L70) and only ever incremented. Nothing resets it. After **one** missed turn, the badge stays for the rest of the session, even when every later turn updates the tasks.

### Root cause B: false positives in what counts as a "missed turn"

- **OpenCode:** an "execution" is not a user message. Interrupts, "continue", and queued messages injected mid-run end an execution (`idle` / `interrupted`). If the agent is still working on an already `in_progress` task, the list legitimately has not changed, but the turn counts as missed.
- **Codex:** any turn with an unchanged list counts, including pure Q&A turns with no work.
- **All:** a turn that just continues the current `in_progress` item has nothing to change, but counts.

Evidence: this OpenCode session (`ses_e2ffef595ffe02084CoFceiuZn`, terminal `t6m`) has `missed_turns: 1` although `todowrite` ran on every user message. Other session stores show `missed_turns` of 1 to 5 (for example `01a1cbda…` = 5, `3fb260d9…` = 2).

### Fix

**1. Reset on change (required).** Wherever the task list is applied and the fingerprint changes, set `missed_turns = 0`:

- `claude.js` `applyTool` (TodoWrite / TaskCreate / TaskUpdate, ~L110-176)
- `codex.js` `update_plan` handling (~L108-121)
- `opencode-plugin.js` `todo.updated` handling (~L307-325)

This makes the badge mean "the agent has stopped updating tasks", which is the intended meaning.

```js
const before = fingerprint(store.tasks);
// ...apply update...
if (fingerprint(store.tasks) !== before) store.missed_turns = 0;
```

**2. Count fewer false positives (recommended).**

- OpenCode: don't count `session.execution.interrupted`, or executions that ended because a queued message was injected. Count only when the turn started from a real user `chat.message`.
- Codex: require tool use in the turn, as Claude already does.
- All: don't count a turn if the list already has an `in_progress` item and the turn was short or a continuation. Or simpler: only count when the list has **no** `in_progress` item, or was empty at turn start.

**3. Mod side (optional).** Store `last_missed_at` and `tasks_updated_at`. Show the badge only if the last miss is newer than the last task change. This also fixes stores already stuck with a non-zero count.

**4. Tests.**

- Reducer: miss -> task change -> `missed_turns === 0`, badge hidden.
- OpenCode: interrupted or queued-message execution -> `missed_turns` unchanged.
- Codex: turn with no tool calls -> `missed_turns` unchanged.

---

## Summary

| # | Bug | Root cause | Primary fix |
|---|---|---|---|
| 1 | Cross-repo PR shown in every tab of a branch | PR filed under the agent's session cwd checkout; URL repo never checked | File the shared record under the PR's own repo + `--head` branch (only if a local checkout's remote matches). The creating session keeps it via its own store. Filter foreign registry records; move the bad `prs.json` entry |
| 2 | Tab rename hits the user's focused tab | Instructions use `herdr-app status` (focused tab) | Use own terminal's `herdr.tab` label via `hc get $env:HC_TERMINAL_ID --json` |
| 3 | "No task updates" badge while tasks update | `missed_turns` never reset; turn boundaries over-count | Reset on task change; ignore interrupted/continuation turns |

Suggested order: Bug 2 (a one-section instruction change) -> Bug 3 fix 1 (one line per adapter) -> Bug 1 write-side check + read-side filter + data cleanup.
