# Ranch: a Herdr layout for agent-heavy work

Ranch is a layout plus a set of mods for the Herdr app (herdr.dev). It puts
every agent's state, git progress and planned tasks on screen, so you can run
many coding agents across machines without opening each terminal to check on it.
It is published to herdr.dev/layouts.

- **Target:** herdr-app ≥ 0.1.15, herdr-core (`hc`) ≥ 0.1.20.
- **Source of truth for the APIs:** `~/.config/herdr-app/AGENTS.md`,
  `herdr.d.ts` and `gpui-kit.d.ts` (Herdr rewrites them on every start).

---

## 1. Terms

The spec uses Herdr's own vocabulary so it maps directly to the API.

| Spec term | Herdr term / API | Notes |
|---|---|---|
| Machine | `machines()`, `spaces()[i].machine` | `null` = this computer. Skip `temporary` machines. |
| Workspace | **space** (`spaces()`) | One machine per space. |
| Tab | **tab** (`spaces()[i].tabs`) | |
| Session | the agent terminal(s) in a tab (`agents()`, `panes()`) | A tab can hold several agents; the tab shows the most urgent one. |
| Status | `Status` = `working` \| `blocked` \| `done` \| `idle` | From OSC 7501. Plain terminals have no status. |
| "Needs you" | `blocked` | UI label only; the data value stays `blocked`. |
| Sub-agent | a terminal started by an agent with `hc run` (`terminals()[i].parent`) | Also see §6.4 for an agent's in-process sub-agents. |

**Status order** (most urgent first, the same as Herdr's): `blocked` > `done` > `working` > `idle` > none.

| Status | Label | Colour (theme token) | Icon / motion |
|---|---|---|---|
| blocked | Needs you | `blocked` | filled dot, gentle pulse (`.loop("opacity")`) |
| done | Done | `done` | check |
| working | Working | `working` | ring spinner (`svg(...).spin(900)`) |
| idle | Idle | `idle` | hollow dot |
| none | (no label) | `dim` | program icon only |

Status is never shown by colour alone: every status also has an icon and a text label (or a tooltip in the compact rail).

---

## 2. What we ship

| Piece | Path | Built from |
|---|---|---|
| Layout | `layouts/ranch.json` + `layouts/ranch.svg` (preview) | `layout.clone` of `main` |
| Sidebar header + footer | `mods/ranch-chrome/` | `mod.clone` of `workspace-chrome` |
| Logo | `mods/ranch-chrome/logo.svg` (full-colour tile), `mods/ranch-chrome/mark.svg` (one-colour glyph); sources in `assets/logo/` | designed for Ranch (§2.1) |
| Sidebar tree | `mods/ranch-sidebar/` | new, borrowing from `spaces` and `agents` |
| Top bar | `mods/ranch-topbar/` | `mod.clone` of `tabs` |
| Session Details panel | `mods/ranch-session/` | new |
| Ranch settings panel | `mods/ranch-settings/` | new |
| Files, Changes panels | shipped `files`, `changes` | reused as-is |
| Task adapters (outside Herdr's folder, set up once) | `adapters/{claude,codex,opencode}/`, plus `bin/ranch-tasks` | new (§7) |

### 2.1 Logo
- **Tile (`logo.svg`, 512×512):**
  - A gambrel barn in rust red `#d4532b` on a charcoal rounded tile `#1f2328`, with a cream `#f1ede4` roof trim and doors.
  - The hayloft window is a green light `#4ade80`, standing for "agents working".
  - Used in the sidebar header, the README and `preview.png`.
- **Mark (`mark.svg`, 24×24):** a stroked outline of the same barn in `currentColor`, so `svg()` tints it with the theme. Used in the compact rail and the top bar.
- It sits beside Herdr's ram icon as a sibling (both are tiles with one flat silhouette) but doesn't copy it.

Rules:
- Herdr's shipped layouts and mods are read-only and get replaced on every start. Clone them; never edit them in place. Clones never receive upstream updates, so the RECIPE must say which Herdr version each one was cloned from.
- Every mod name starts with `ranch-` so nothing clashes with other people's mods.
- No HTML, CSS, `setTimeout` or Node APIs. Use gpui-kit, `cx.timer`, `exec` and `fetch`.
- Animate with `.frames`, `.spin` and `.loop`, never with a timer that calls `cx.notify()`.

---

## 3. Window

```
┌──────────────┬──────────────────────────────────────────────┬───────────────┐
│ ranch-chrome │ ranch-topbar                                 │               │
│ (header)     ├──────────────────────────────────────────────┤ right panel   │
│ ranch-sidebar│                                              │ (one of:      │
│              │   active tab (panes as cards)                │  Session,     │
│              │                                              │  Files,       │
│              │                                              │  Changes,     │
│ ranch-chrome │                                              │  Settings)    │
│ (footer)     │                                              │               │
└──────────────┴──────────────────────────────────────────────┴───────────────┘
```

- Sidebar: 268 px by default, min 44 / max 480, resizable. Below 160 px it draws a compact rail (§4.5).
- Right panel: a `stack` with one child per panel. **Only one panel is open at a time**; clicking its toggle again closes it. Width is resizable (min 280, max 640, default 360). The open panel and its width are remembered per space, as the shipped `tabs` mod already does with `localStorage`.

---

## 4. Sidebar

### 4.1 Header (`ranch-chrome`)
- **R-SB-1** The Ranch logo (`mods/ranch-chrome/logo.svg` drawn with `image()`, 20 px) and the name "Ranch", then search (opens `picker`) and a collapse toggle. The header is a `window_drag` area. On macOS it leaves room for the traffic lights.
- **R-SB-2** The collapse toggle switches between the full sidebar and the compact rail. Shortcut: `ctrl-shift-b` (Herdr's default).

### 4.2 Tree (`ranch-sidebar`)
The hierarchy is **Machine → Space → Tab (session card)**.

- **R-SB-3 Machine row.** Name ("This Mac" for `null`), connection state (`ready` / `loading` / `unavailable`), and a count of its agents that need you. When `unavailable` the row is dimmed with the reason, and a `hc machine login <name>` Copy action where Herdr offers one. Collapsible. Only shown when more than one machine exists.
- **R-SB-4 Space row.** Space name, the most urgent status of its tabs, and a **+** button that opens the new-tab menu (the shipped `new-menu`) for that space. Collapsible; a collapsed space still shows its status and its "needs you" count. Worktree spaces nest under their repo's space, as in the shipped `spaces` mod.
- **R-SB-5 Session card**, one per tab, always three lines tall so the list is easy to scan:

  | Line | Left | Right |
  |---|---|---|
  | 1 | repo name (repo of the tab's first terminal, else folder name, `~` at home) | status label + time in that status, e.g. `Working · 4m` |
  | 2 | git branch (` ` icon); `detached @abc1234` when detached | agent icon (`program.icon` of the most urgent agent) |
  | 3 | `12 files  +340  −87` (see R-SB-7) | PR link `#123`, coloured by PR state |

- **R-SB-5a Status bar.** Every session card has a 2px bar on its left edge coloured by the agent's status: idle grey, working yellow, needs you red, done blue (theme `muted`, `ansi3`, `ansi1`, `ansi4`). Cards without an agent have no bar. The selected card is shown by its background, not the bar.
- **R-SB-6 Time.** While `working`: now − `tab.working_since`. For the other statuses: now − `tab.changed_at`. Format `<1m`, `4m`, `1h 12m`, `2d`. Update once a minute (one shared timer), not every second.
- **R-SB-7 Diff stats** count everything on the branch that the default branch doesn't have, committed and uncommitted: `git diff --shortstat $(git merge-base HEAD <default>)`. The **same number** appears in Session Details (§6.2). Default branch: `git symbolic-ref refs/remotes/origin/HEAD`, else `main`, else `master`.
- **R-SB-8 Missing data.** No repo: line 2 shows the folder and line 3 is empty. No PR: the right side of line 3 is empty. No agent: the status is empty and the program icon is shown. Never print "null", "undefined" or empty brackets.
- **R-SB-9 Narrow widths.** The right side wins. Status and PR are never cut; repo and branch get an ellipsis in the middle (`feature/…/login`).
- **R-SB-10 Interaction.** Click a card to select that tab. Right-click opens tab actions (rename, settle, close). Click the PR link to open it in the browser. Calls `setAgentOrder(...)` on render so `agent.next` / `agent.prev` follow the sidebar's order.
- **R-SB-11** Settled tabs fold into a "Settled (n)" row at the bottom of their space.

### 4.3 Footer (`ranch-chrome`, `footer: true`)
- **R-SB-12** Counts by status from `agents()`: `● 3 working · ● 1 needs you · ● 2 done`. Hide a status when its count is 0. Show "No agents running" when everything is 0.
- **R-SB-13** Click "needs you" to focus the next blocked agent (`agent.focus`). Click any other count to filter the tree to that status; click it again to clear the filter.

### 4.4 Data and refresh
- Spaces, tabs, agents and status come from Herdr's live data (`spaces()`, `agents()`, `panes()`, `terminals()`). Mods re-render automatically, so these are never polled.
- Git runs through `exec("git", …, { cwd, on: space.machine })`, so remote spaces work.
  - Local spaces: refresh on `watchFolder(repo)`, debounced to 1 s.
  - Remote spaces: a timer every 15 s.
  - One git query per repo, shared by every card on that repo.
- PRs run through `exec("gh", ["pr", "view", "--json", "number,url,state,isDraft"], …)`.
  - Cache per (repo, branch) for 120 s. Refresh the active space's PRs first.
  - If `gh` is missing or signed out, hide the PR fields and say why once in Ranch settings, rather than erroring on every card.

### 4.5 Compact rail (< 160 px)
- **R-SB-14** Logo, then one icon per space (with its status dot), a "needs you" badge, and the expand toggle. A tooltip on hover shows the space name and its status counts.

---

## 5. Top bar (`ranch-topbar`)

### 5.1 Left: the current tab
- **R-TB-1** Agent icon · space name › tab name (double-click to rename) · close button · **+** (new tab in this space).
- **R-TB-2** Closing a tab whose agent is `working` or `blocked` asks first (the shipped `confirm` mod). Closing the last tab warns that the space closes too.
- **R-TB-3** Only the current tab is shown here. Switching tabs happens in the sidebar, with `tab.next` / `tab.prev`, or with `ctrl-1…9`. The RECIPE documents this.

### 5.2 Right, group 1: start an agent
- **R-TB-4** One button per agent, launching `tab.new { space, argv: agent.run }`.
  - Defaults: Claude Code, Codex, OpenCode, and Terminal (Terminal = `tab.new` with no `argv`).
  - The list is **configurable** in Ranch settings: you choose from `knownAgents()`, which includes anything added in `programs.json`.
  - Agents that aren't installed are hidden, or shown greyed out with an "Install" tooltip.
- **R-TB-5** Each button has a tooltip and an optional shortcut (`mod:ranch-topbar` keys).

### 5.3 Right, group 2: panel toggles
- **R-TB-6** Session Details · Files · Changes · Settings. One panel at a time (§3). The open toggle is highlighted. Each toggle runs `layout.select` / `layout.hide` on the right-panel stack.
- **R-TB-7** Default shortcuts, active only while the Ranch layout is shown (`layout:ranch` in `keys.json`): `cmd-alt-1` Session, `cmd-alt-2` Files, `cmd-alt-3` Changes, `cmd-alt-4` Ranch settings (`ctrl-alt-1…4` on Linux and Windows). `cmd-,` stays Herdr's own settings. The installer merges `keys.json` and asks before replacing any key the user already uses.

---

## 6. Session Details panel (`ranch-session`)

It shows the **focused tab**. If the tab has several agents, a picker at the top chooses which one; the default is the most urgent.

### 6.1 Tasks (top of the panel)
- **R-SD-1** Lists the session's tasks from the task store (§7), in the order the agent sent them: `in_progress` first and highlighted, then `pending`, then `completed` (folded after 5).
- **R-SD-2** A header shows a progress bar: `3 / 7 done`.
- **R-SD-3** Empty states:
  - Supported agent, no tasks yet: "No plan yet."
  - Agent Ranch doesn't support (not Claude Code, Codex or OpenCode): "This agent doesn't report tasks."
  - Adapter missing or broken (for example after an agent update): "Task reporting isn't set up", with one **Set up** button that runs `ranch-tasks install` (§7.1).
- **R-SD-4** **Tasks belong entirely to the agent.** The panel only displays them: there is no way to add, edit, reorder or check off a task, and nothing is ever sent to the agent from this panel.

### 6.2 Git
Every value below is a link. On hover it shows a dotted underline and a pointer cursor. Links go to the repo's web host (GitHub or GitLab, detected from `remote.origin.url`). With no recognised host, values are plain text.

- **R-SD-5 Branch:** `feature/login` → branch page. Shows `↑2 ↓5` ahead/behind against `origin/<branch>`, labelled "vs remote". Hidden when the branch has no upstream.
- **R-SD-5a Commits vs default branch:** `12 ahead · 3 behind main`.
  - Computed with `git rev-list --left-right --count HEAD...<default ref>`, where the default ref is `origin/<default>` when it exists (so it reflects the remote), else the local `<default>`.
  - "Ahead" links to the host's compare view (`<default>...<branch>`). "Behind" is plain text, coloured as a warning when it is above 0, with the tooltip "main has N commits this branch doesn't".
  - On the default branch itself the line reads "On main" and shows no counts.
- **R-SD-6 Changes vs default:** `vs main · 12 files +340 −87`, the same number as R-SB-7. Below it, the changed files with +/− for each. Clicking a file opens it in the **Changes** panel, not in the browser.
- **R-SD-7 PR:** `#123` title, state (draft / open / merged / closed), review decision, and a CI summary (`✓ 8 ✗ 1 ◌ 2`) from `gh pr view --json number,title,url,state,isDraft,reviewDecision,statusCheckRollup`. No PR: a "Create PR" link (the host's compare URL).
- **R-SD-8 Recent commits:** collapsed by default and showing the count. When open, the last 5 commits on the branch: short SHA (link), subject, author and relative time.

### 6.3 Sub-agents
- **R-SD-9** Collapsible list of the session's sub-agents:
  - **Herdr sub-agents** (terminals whose `parent` is this agent): name, program icon, status, time. Click to peek (`terminal.peek`); "Keep as tab" runs `terminal.keep`.
  - **In-process sub-agents** (for example Claude Code's Task tool), when an adapter reports them (§7): name/description, status (running / done / failed), duration. Read-only.
- **R-SD-10** The header shows counts: `Sub-agents · 2 running · 3 done`.

---

## 7. Task reporting (agent adapters)

### 7.1 Principles
1. **The agent is the only author of its tasks.** Ranch reads the to-do list the agent already keeps (Claude Code, Codex and OpenCode all keep one) and only displays it. The user never creates, edits or confirms tasks.
2. **Nothing to do after setup.** Setup runs once and covers all three agents: `ranch-tasks install` during installation (the RECIPE's install step), or the **Set up** button (R-SD-3). After that, every new session reports tasks with no user action and no per-project step.
3. **Task reporting is mandatory for every user message** (the user's explicit choice). `ranch-tasks install` adds a marked rules block to each agent's global instructions: `~/.claude/RANCH.md` imported from `~/.claude/CLAUDE.md` by one marked line, `~/.codex/AGENTS.md`, and `~/.config/opencode/AGENTS.md`. Claude and Codex hooks also inject a one-line reminder on every prompt and at session start, and the OpenCode plugin adds the rule to every system prompt (`experimental.chat.system.transform`). Ranch still never sends text into an agent's terminal.
4. **Reversible and disclosed.** Adapters live outside Herdr's folder, so the herdr.dev install alone doesn't add them. Install tells the person which files it will change before changing them (as Herdr's rules require), backs each one up, and is idempotent. `ranch-tasks uninstall` restores the files exactly.
5. **Fail silently, never break an agent.** A hook that can't run (Node missing, disk full) exits 0 with no output, so the agent never sees an error. Problems show up in Ranch settings › Health instead.

### 7.2 Store
- One JSON file per agent terminal, on the machine where the agent runs: `~/.herdr/ranch/tasks/<terminal-address>.json`. The address comes from `$HC_TERMINAL_ID`, which herdr-core sets in every terminal.
- Writes are atomic (write to a temp file, then rename).
- `ranch-session` reads the file with `readTextFile(path, { on: machine })` and watches it with `watchFolder` locally (timer when remote).
- Files for finished terminals are removed by the mod (once `terminals()` reports the terminal as finished) and by `ranch-tasks gc`.

### 7.3 Schema (v1)
```json
{
  "version": 1,
  "terminal": "t6",
  "agent": "claude-code",
  "updated_at": "2026-11-11T10:42:00Z",
  "session": { "id": "abc123", "title": "Fix login redirect", "title_source": "agent", "first_prompt": "the login page loops…", "state": "running" },
  "tasks": [
    { "id": "1", "title": "Read the spec", "status": "completed" },
    { "id": "2", "title": "Write ranch-sidebar", "status": "in_progress", "active_form": "Writing ranch-sidebar" }
  ],
  "subagents": [
    { "id": "a1", "name": "explore auth", "status": "running", "started_at": "…", "ended_at": null }
  ]
}
```
- `status` is one of `pending` | `in_progress` | `completed`.
- `session` feeds smart tab names (§8):
  - `title`: the agent's own session name (for example after Claude Code's `/rename`, or its automatic title).
  - `title_source`: `agent` (the agent set it) or `user` (the user renamed the session inside the agent).
  - `first_prompt`: first 500 characters of the first user message.
  - `state`: `running` | `ended`.
  - Adapters fill it from session-start, prompt-submit and session-end hooks, where the agent has them.
- Unknown fields are ignored. A newer `version` shows "Update Ranch to see tasks".

### 7.4 Adapters (v1)
Every hook event name and payload below must be checked against the agent version you install for. Each one is pinned in `adapters/<agent>/README.md`.

| Agent | Tasks from | Sub-agents from | Mechanism |
|---|---|---|---|
| Claude Code | the to-do / task-list tool calls (`PostToolUse` on `TodoWrite`, and the newer task tools if present) | `SubagentStart` / `SubagentStop` hooks | `settings.json` hooks calling `ranch-tasks claude` |
| Codex | plan updates (`update_plan`) via Codex hooks / notify | not available, so omit | Codex config calling `ranch-tasks codex` |
| OpenCode | `todowrite` / todo-updated plugin events | sub-session events if exposed | OpenCode plugin (`ranch-tasks.js`) |
| Others | not supported in v1 | n/a | the panel shows "This agent doesn't report tasks" |

All three adapters ship in v1. Each one also fills `session` (§7.3) for smart tab names: session id and title, first prompt, and start/end.

`ranch-tasks` is a single Node.js script (Node ≥ 18, no npm packages).
- It reads hook JSON on stdin and writes the store.
- Subcommands: `claude`, `codex` (hook entry points), `gc`, `install`, `uninstall`, `status`. There are no commands for editing tasks.
- The OpenCode adapter is a plugin file (`ranch-tasks.js`) that runs inside OpenCode and writes the same store directly, so it doesn't need Node.
- If Node is missing, Claude Code and Codex task reporting is off; Health says so and explains how to install Node.
- On a remote machine, `ranch-tasks install` is run there (`hc exec --on <machine> …`); the Set up button does this for remote spaces.

---

## 8. Smart tab names

**The AI owns tab names.** Tabs name themselves after what the agent's session is doing and update as the session starts, gets renamed and ends. The user can still rename a tab in Herdr; that name is kept as an override and **never overwritten**, but it stays in Herdr only (R-TN-11).

### 8.1 Ownership: who owns a tab's name
Herdr's `tab.named` flag becomes true for any rename, including Ranch's, so Ranch keeps its own record: `shared("ranch.autoNames")[tabId] = { name, source, at }`.

| State | How it's detected | What Ranch does |
|---|---|---|
| **Unnamed** | `named == false` | Free to auto-name. |
| **Auto** | `named == true` and `name == autoNames[tab].name` | Free to rename, but only to a better source (§8.3). |
| **User-locked** | `named == true` and `name != autoNames[tab].name` (the user renamed it in Herdr) | Never touched again. |

- **R-TN-1** A user-locked name stays until the user clears it ("Reset name" in the tab menu, which runs `tab.rename {name: ""}`). That returns the tab to Unnamed and auto-naming resumes.
- **R-TN-2** The tab menu and the top-bar tab name show a small lock or "auto" marker, so it's clear whether Ranch will change the name. Hovering explains the source ("Named from Claude's session title").

### 8.2 Events

| Event | Detected from | Behaviour |
|---|---|---|
| **Session start** | an agent appears in the tab (`agents()`), or the adapter's session-start hook | Set a provisional name straight away: `<Agent> · <repo>` (for example "Claude · ranch"). If the tab was opened with a `task`, use that instead (§8.4). |
| **First prompt** | adapter `session.first_prompt`, or the `tab.new {task}` text | Upgrade to a short name made from the prompt (§8.4). |
| **Agent session renamed** | adapter `session.title`, or a change in the agent's terminal title (`panes()[i].title`) | Follow it (`/rename` in Claude Code renames the tab). A title with `title_source: "user"` outranks everything except a Herdr user-lock. |
| **Session resumed** | adapter session-start with a known session id (for example `claude --resume`) | Restore that session's last name. Ranch keeps the last 200 session-id → name pairs. |
| **Branch switched** | `pane.branch` changes | Rename only if the current name came from the branch. |
| **Session exit** | the agent's status disappears and the pane goes back to a shell, or the adapter reports `state: "ended"` | See R-TN-3. |
| **Tab moved to another space / Herdr restart** | n/a | Names persist (they're real Herdr tab names). Ranch's ownership record lives in shared state, so it survives restarts. |

- **R-TN-3 On exit:**
  - If the session did meaningful work (had tasks, commits or a diff), keep the name and show "ended" in the card status. This is the default.
  - If it did nothing, revert to Herdr's default name (`tab.rename {name: ""}`).
  - Configurable: keep / revert / add the prefix "✓ ".
  - If a new agent starts in the same tab, the naming flow starts again from "Session start".

### 8.3 Source priority (higher wins, never downgrades)
1. A name the user typed in Herdr (user-locked, §8.1)
2. A name the user gave inside the agent (`title_source: "user"`, for example `/rename`)
3. The agent's own automatic session title (adapter `session.title`, or a cleaned terminal title)
4. A summary of the first prompt or launch task
5. The branch name, made readable (`feature/fix-login-loop` → "Fix login loop"). Skipped for the default branch.
6. The provisional `<Agent> · <repo>`
7. Herdr's default (the tab's number)

The current in-progress task is **not** a name source, because it changes too often. It appears as the card's tooltip and in Session Details.

### 8.4 Making a good name
- **R-TN-4 Clean the title:**
  - Strip spinner and status glyphs (`✳ ⠋ ● ✓`), the agent's name ("Claude Code", "OpenCode"), paths, `user@host:`, and trailing ellipses.
  - Ignore generic titles ("claude", "zsh", "New session", the bare repo name). They don't count as a source.
- **R-TN-5 Summarise prompts without a model (default):**
  1. Take the first sentence.
  2. Drop filler ("can you", "please", "I want you to", "help me").
  3. Keep the verb and object ("fix the login redirect loop on Safari" → "Fix login redirect loop").
  4. Keep issue keys or numbers if present (`#123`, `ABC-42`).
  5. Cap at 4–6 words and 32 characters, with sentence case.
- **R-TN-6 Summarise with a model (opt-in, off by default):** ask a small, fast model through an agent CLI already installed (for example `claude -p --model haiku "<3–5 word title for: …>"`), with a 5 s timeout, falling back to R-TN-5. Ranch settings must say clearly that this sends the first prompt to that provider. It runs once per session, never per keystroke.
- **R-TN-7 No flicker:**
  - Rename only when the new name comes from a higher source, or the same source with a different value.
  - Debounce for 3 s, and wait at least 15 s between automatic renames of one tab (an agent rename, R-TN-1 or user action skips the wait).
  - Never rename while the user is editing the tab name.
- **R-TN-8 Duplicates:** if another tab in the same space has the same name, add the branch ("Fix login · auth-v2"), else " 2".
- **R-TN-9 Several agents in one tab:** the tab is named after its *primary* agent, which is the first one started. Sub-agents never rename the tab.
- **R-TN-10 Space names are out of scope.** Herdr already names unnamed spaces after their repo.
- **R-TN-11 Names flow one way: agent → tab.**
  - A rename in Herdr is never sent to the agent. Ranch never runs `hc send`, `hc keys` or `/rename`, and never writes the agent's session files, config or transcript.
  - The agent's session keeps its own title. Its work isn't interrupted, and no prompt, keystroke or message reaches its terminal.
  - While a tab is user-locked, Ranch still records the agent's latest session title, so "Reset name" switches straight back to the AI's current name.

### 8.5 Where it runs
- In `ranch-sidebar`. Its block always stays in the layout, so the copy stays alive while hidden.
- It runs `tab.rename {id, name}` and only acts on tabs of the machines it can see.
- Several connected Herdr screens may run Ranch at once. Naming is deterministic (same inputs → same name) and checked against the current name before renaming, so two clients can't fight over a name.
- If Ranch isn't the shown layout, auto-naming pauses. Names that were already set stay.

---

## 9. Ranch settings panel (`ranch-settings`)

- Top-bar agent buttons: choose from `knownAgents()`, reorder, show/hide.
- Show/hide each sidebar line (line 3, PR, time) and each Session Details section.
- Refresh intervals: remote git (default 15 s), PRs (default 120 s).
- Smart tab names (§8):
  - on/off
  - what happens on exit (keep / revert / ✓ prefix)
  - follow agent renames (on)
  - model summaries (off, with the privacy note)
  - maximum length (32)
- Task reporting: read-only status per agent and machine (from `ranch-tasks status`), with **Set up / Repair** when something is missing or broken. There are no per-task or per-project settings.
- Health: `git` / `gh` found and signed in, Herdr version supported.
- A link to Herdr's own settings (`app.settings`).
- Saved with `setShared("ranch.*", …)`.

---

## 10. Non-functional

- **Performance:** with 30 tabs over 3 machines, the sidebar stays smooth. At most one git process per repo in flight, and at most 4 `gh` calls at once. Hidden copies keep their timers, so poll gently.
- **Themes:** only `theme()` tokens, never hex. Check in `graphite` (dark) and `paper` (light).
- **Keyboard:** every action reachable by key or palette. The sidebar and panel are `focusable: true` for `pane.go`.
- **Errors:** a failed git or `gh` call shows an inline dim "—" with a tooltip, never a toast storm. `herdr-app status` shows no mod errors.
- **Privacy (disclosed in the RECIPE):** the mods run `git`, `gh` and `hc` on your machines, read `~/.herdr/ranch/tasks/`, and reach the network only through `gh`. No telemetry of its own.

---

## 11. Publishing (herdr.dev/layouts)

- A public GitHub repo with `layouts/ranch.json`, `layouts/ranch.svg`, `mods/ranch-*/`, `keys.json`, `RECIPE.md`, `preview.png`, and the topic `herdr-layout`.
- `adapters/` and `bin/ranch-tasks` sit in the same repo. The RECIPE's install steps include running `ranch-tasks install` once, after telling the person which agent config files it changes.
- `RECIPE.md` follows Herdr's order: Name, What you see, How it behaves (every status), Built from, Watch out, Done when.
- Before release:
  - `herdr-app check` passes for every `mods/ranch-*`.
  - `herdr-app status` shows `"errors": []`.
  - `herdr-app shot` screenshots taken in light and dark.

---

## 12. Acceptance criteria (Done when)

1. `layout.switch {name: "ranch"}` shows the window in §3 with no errors in `herdr-app status`. `ctrl-shift-l` switches back.
2. Start Claude Code in a repo on a branch with an open PR. Its card shows repo, `Working · <1m`, branch, the Claude icon, matching diff stats and a clickable `#PR`.
3. When the agent asks for permission, the card, space, machine and footer all show "Needs you" within 1 s. Clicking the footer count focuses that agent.
4. Collapsing the sidebar shows the rail with the needs-you badge. Expanding restores it.
5. Each agent button in group 1 opens a new tab running that agent in the current space. A user-added `programs.json` agent can be added from Ranch settings.
6. The panel toggles open one panel at a time and remember it per space.
7. After one `ranch-tasks install`, new Claude Code, Codex and OpenCode sessions each show their to-do list in Session Details and update it as items complete, with no other user action. The panel has no controls that change tasks. Uninstalling restores every changed config file byte for byte.
8. The diff numbers in Session Details match the sidebar card and `git diff --shortstat $(git merge-base HEAD main)`. The ahead/behind counts against the default branch match `git rev-list --left-right --count HEAD...origin/main`.
9. A sub-agent started with `hc run` shows under Sub-agents with its status, and peeking at it works.
10. A space on a remote machine shows correct git data. When that machine goes offline it shows `unavailable` without errors.
11. Start Claude Code with no task: the tab reads "Claude · <repo>" at once, then a short summary of the first prompt within a few seconds of sending it.
12. `/rename Payment retries` inside Claude Code renames the tab to "Payment retries".
13. Rename a tab by hand in Herdr while its agent is working: no later agent title, prompt or branch change renames it. The agent's session title is unchanged, and `hc read` shows nothing was typed into its terminal. "Reset name" brings back the AI's current name.
14. Exit an agent that made no changes: the tab goes back to its number. Exit one that made commits: the tab keeps its name and shows "ended".
15. `claude --resume` of an earlier session in a fresh tab restores that session's name.
16. Ten agents starting at once give ten readable names that don't repeat within a space, and no tab is renamed more than once in 15 s (apart from explicit renames).
17. Everything above works in `graphite` and `paper`.

---

## 13. Decisions

1. **Logo:** Ranch has its own logo (§2.1), designed for this project and shipped in `mods/ranch-chrome/`.
2. **Adapter language:** Node.js for `ranch-tasks`; OpenCode's adapter is an in-process plugin.
3. **Agents:** Claude Code, Codex and OpenCode all get task and session adapters in v1.
4. **Tab names belong to the AI:** the agent's session drives the tab name (§8). The user can still rename a tab in Herdr, but that rename stays in Herdr only. It is never sent to the agent, never renames the agent's session, and never types into or interrupts the terminal.
5. **Tasks belong to the agent:** agents create and update them; Ranch only displays them (R-SD-4, §7.1).
