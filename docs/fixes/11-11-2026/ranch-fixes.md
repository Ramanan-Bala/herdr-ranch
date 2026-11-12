# Ranch layout + ranch-tasks: issues and required fixes (Windows)

Date: 2026-11-11 · Ranch commit `6662a24` (github.com/Ramanan-Bala/herdr-ranch, `main`)
Machine: Windows, Herdr app, Git for Windows `sh` on PATH, Node on PATH.

> Scope: these fixes are **not applied** to the Ranch mods. Only the installer patch in section 1 is live (kept on purpose).
> Paths are relative to the Ranch repo unless they start with `~`.
> Installed copies: mods in `~/.config/herdr-app/mods/ranch-*`, task runtime in `~/.herdr/ranch/`, OpenCode plugin in `~/.config/opencode/plugins/ranch-tasks.js`.

---

## 0. Change log (what was done on this machine)

| When | Change | Undo |
|---|---|---|
| Install | Removed custom `gtpfs-*` mods/data, `herdr-workspace` layout, layout click state; shipped layouts restored by the app | Backup `~/.config/herdr-app-backup-20261111-185916` |
| Install | Added `layouts/ranch.json` + `ranch.svg`, 9 `mods/ranch-*`, `layout:ranch` keys in `keys.json` | Delete them; restore `keys.json` from backup |
| Install | `ranch-tasks install --yes` with the **local installer patch (section 1)** | `node ~/.herdr/ranch/bin/ranch-tasks.js uninstall --yes` |
| Cleanup | Removed old `todos.mjs remind` + `todos.mjs claude` hooks from `~/.claude/settings.json` | Backup `agent-configs/.claude__settings.json` |
| Cleanup | Removed old `todos.mjs remind` + both `todos.mjs codex` hooks from `~/.codex/hooks.json` | Backup `agent-configs/.codex__hooks.json` |
| Cleanup | `~/.config/opencode/plugins/herdr-todos/index.js`: removed REMINDER injection, `claim()` and `save()` into the old store. **Kept the `todowrite` tool**: Ranch's OpenCode plugin listens to it | Backup `agent-configs/opencode__plugins__herdr-todos__index.js` |
| Cleanup | Deleted `~/.config/herdr-app/data/gtpfs-todos` (old store, nothing reads it) | Backup folder |
| Kept | `tab-title.mjs` hooks (tab titles, unrelated to tasks); `~/.config/herdr-core/todos.mjs` file (now unused) | n/a |

Backups: `~/.config/herdr-app-backup-20261111-185916/agent-configs/` and Ranch's own `~/.herdr/ranch/backups/`.

---

## 1. Installer patch (APPLIED, kept): `adapters/install.js`

Live in the clone and the installed copy `~/.herdr/ranch/adapters/install.js`. If Ranch is reinstalled from upstream without it, issues F1/F2 come back.

```diff
@@ -50,6 +50,13 @@ function isRanchGroup(group) {
+function hookCommand(agent) {
+  const bin = join(homeDir(), RANCH_MARK.slice(1));
+  // Windows: hooks can't run the sh launcher, and backslash paths miss RANCH_MARK; call node on the .js entry.
+  if (process.platform === "win32") return `node "${bin.replace(/\\/g, "/")}.js" ${agent}`;
+  return `${bin} ${agent}`;
+}
+
@@ -412,7 +419,7 @@ (installClaude)
-  const command = `${join(homeDir(), RANCH_MARK.slice(1))} claude`;
+  const command = hookCommand("claude");
@@ -431,7 +438,7 @@ (installCodex)
-  const command = `${join(homeDir(), RANCH_MARK.slice(1))} codex`;
+  const command = hookCommand("codex");
@@ -569,7 +576,7 @@ function installInstructions(agents, results, backups) {
-    if (existed && !f.whole) backupFile(f.path, `instructions-${f.path.split("/").slice(-2).join("-")}`, backups);
+    if (existed && !f.whole) backupFile(f.path, `instructions-${f.path.split(/[\\/]/).slice(-2).join("-")}`, backups);
```

Verified after patch: `ranch-tasks status --json` → claude/codex/opencode `installed`, `opencodeTodo: true`.

---

## 2. Issues and fixes

Severity: **High** = broken on Windows or wrong data · **Medium** = wrong in common cases · **Low** = cosmetic/edge.

### F1. High: installer crashes on Windows (backup file name) (FIXED by section 1)
- **Where:** `adapters/install.js` `installInstructions`, ~line 572.
- **Why:** `f.path.split("/")` does nothing on `C:\...` paths, so the backup name is the whole path → `ENOENT` on copy. Install aborts halfway, after hooks were written.
- **Fix:** split on `/[\\/]/` (section 1).

### F2. High: hook command cannot run on Windows and is not recognized (FIXED by section 1)
- **Where:** `adapters/install.js` `installClaude`/`installCodex`; `RANCH_MARK` + `isRanchGroup()` lines 17, 48-51.
- **Why:** command was `C:\Users\...\.herdr\ranch\bin\ranch-tasks claude`: a `#!/bin/sh` launcher with backslashes. Windows can't execute it. `isRanchGroup()` looks for `/.herdr/ranch/bin/ranch-tasks`, so status says *missing*, reinstall **duplicates** hooks, uninstall **can't remove** them.
- **Fix:** `hookCommand()` (section 1). Forward slashes keep `RANCH_MARK` matching.

### F3. High: Settings panel "Task reporting" rows + "Set up" button fail on Windows
- **Where:** `mods/ranch-settings/main.js` line 8, 64, 89; `mods/ranch-session/main.js` line 312, 331.
- **Why:** `exec(home() + "/.herdr/ranch/bin/ranch-tasks", ...)` starts an extensionless `sh` script; Windows `CreateProcess` can't. Panel shows error/missing although reporting works.
- **Fix** (`ranch-settings/main.js`):
  ```js
  const isWin = () => home().includes(":") || home().startsWith("\\\\");
  const tasksCmd = (dir, args) => isWin()
    ? ["node", [`${dir}/.herdr/ranch/bin/ranch-tasks.js`, ...args]]
    : [`${dir}/.herdr/ranch/bin/ranch-tasks`, args];

  // line 64
  const r = await exec(...tasksCmd(home(), ["status", "--json"]));
  // line 89
  const r = await exec(...tasksCmd(home(), ["install", "--yes"]));
  ```
  Same in `ranch-session/main.js` 312/331 with `dir`/`homeDir` and `{ on: machine }`. (Use the mod API's platform value instead of the `home()` check if gpui-kit exposes one.)

### F4. Medium: reused terminal id shows the previous agent's list
- **Where:** `adapters/store.js` `readStore()` lines 24-32; `mods/ranch-session/main.js` `loadTasks()` 178-214.
- **Why:** store key is only `HC_TERMINAL_ID`. After a herdr-core restart ids restart (`t1`, `t2`, ...). `readStore` returns the old file as-is, so a new agent appends to the old list, and the panel shows it until overwritten.
- **Fix** (writer side, `store.js`):
  ```js
  export function readStore(path, agent, terminal) {
    try {
      const parsed = parseStore(readFileSync(path, "utf8"));
      if (parsed.ok && parsed.store.agent === agent) return parsed.store;
    } catch {}
    return emptyStore(terminal, agent);
  }
  ```
  Also reset on `SessionStart` when `session.id` changes (in `claude.js`/`codex.js`/opencode plugin).
  **Reader side** (`loadTasks`): show the list only if `parsed.store.agent` equals the live agent's app (`agent.app`/kind) and `updated_at` is newer than the terminal's start time. This is our old `gtpfs-todos` `join()` rule.

### F5. Medium: no automatic cleanup of stale lists
- **Where:** cleanup only in `ranch-tasks gc` (`adapters/install.js` `gcStores()` line 802), never run automatically.
- **Fix:** call `gc` from `ranch-session` `init` (once per app start) via the F3 `tasksCmd`, and hide (not delete) in `loadTasks` when:
  - all tasks `completed` and `updated_at` older than 10 min and agent idle, or
  - terminal finished for > 2 min.

### F6. Medium: Claude `TaskCreate` id parsed from reply text
- **Where:** `adapters/claude.js` lines 81-94.
- **Why:** regex `Task #(\S+) created successfully` breaks if Claude rewords it; then `TaskUpdate` can't find the task and falls back to `tasks.length + 1` (wrong ids, duplicates).
- **Fix:** after `TaskCreate`/`TaskUpdate`, rebuild from Claude's own store:
  ```js
  import { readdirSync, readFileSync } from "node:fs";
  function claudeTasks(sessionId) {
    const dir = join(homeDir(), ".claude", "tasks", sessionId);
    return readdirSync(dir).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
      .filter((t) => t.status !== "deleted")
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((t) => ({ id: String(t.id), title: t.subject, status: t.status, active_form: t.activeForm ?? null }));
  }
  ```
  Use it when `payload.session_id` is set; keep the regex as fallback.
  > (Transcriber note, from ranch-task-reporter-integrity.md I1:) in the current Claude version `~/.claude/tasks/<session>/` only holds `.highwatermark` and `.lock`, so this approach may not work — prefer `tool_response.task.id`.

### F7. Medium: cancelled tasks silently dropped (OpenCode)
- **Where:** `adapters/opencode-plugin.js` (installed `ranch-tasks.js` line 159-162).
- **Fix:** keep them:
  ```diff
  -    if (!todo || todo.status === "cancelled") return [];
  +    if (!todo) return [];
  ```
  Add `"cancelled"` to `TASK_STATUS` and `lib/tasks.js` `parseStore`; in `ranch-session` render struck-through and exclude from the `x of y` total.

### F8. Low: OpenCode tasks all have `id: ""`
- **Where:** same reducer, line 166.
- **Fix:**
  ```diff
  -  return [{ id: todo.id === undefined || todo.id === null ? "" : String(todo.id),
  +  return [{ id: todo.id == null || todo.id === "" ? String(index + 1) : String(todo.id),
  ```
  (use `flatMap((todo, index) => ...)`).

### F9. Low: Claude store has `session.id: null` until `SessionStart`
- **Where:** `adapters/claude.js`.
- **Fix:** every hook payload carries `session_id`; set `store.session.id ??= payload.session_id` on any event.

### F10. Medium: editor detection fails on Windows
- **Where:** `mods/ranch-session/main.js` `maybeDetectEditor()` 753-770, launch at 657.
- **Why:** Git `sh` returns `/c/Users/.../code` (MSYS path to a bash script). `exec` can't start it.
- **Fix:**
  ```js
  const r = isWin()
    ? await exec("where.exe", ["cursor.cmd", "code.cmd", "zed.exe", "subl.exe"], { on: machine })
    : await exec("sh", ["-c", "command -v cursor || command -v code || command -v zed || command -v subl"], { on: machine });
  path = r.stdout.trim().split(/\r?\n/)[0] || null;  // where.exe exits 1 if some names are missing, so do not require code 0
  ```
  At line 657, for `.cmd` paths: `exec("cmd.exe", ["/c", editor.path, top])`.

### F11. Medium: usage panel depends on `sh` + Unix tools
- **Where:** `mods/ranch-usage/main.js` lines 100, 119, 144, 148 (`exec("sh", [helper])` every 5 min).
- **Fix:** short term, document "Git for Windows `sh` must be on PATH". Long term, port `helpers/*.sh` to Node and run `exec("node", [helper.js])`.

### F12. Low: remote home lookup uses `sh`
- **Where:** `mods/ranch-session/main.js` `homeFor()` line 136.
- **Fix:** OK for Linux/macOS remotes. For a Windows remote, fall back to `exec("cmd.exe", ["/c", "echo %USERPROFILE%"])` and normalize `\` to `/`.

### F13. Low: duplicate "use the todo tool" reminders (OpenCode)
- **Where:** plugin `TASK_RULE` (`ranch-tasks.js` line 257, injected at 390 and 490) + `~/.config/opencode/AGENTS.md` Ranch block.
- **Status:** our old REMINDER is already removed. Ranch still injects its rule twice (system prompt + AGENTS.md).
- **Fix:** keep one. Add an installer option `--no-instructions`, or skip `TASK_RULE` when the AGENTS.md block exists.

### F14. Low: cosmetic / platform
- `mods/ranch-session/main.js` line 123: `"This Mac"` → `isWin() ? "This PC" : "This Mac"`.
- `gh` fallback paths are Unix-only (`/opt/homebrew/bin/gh`, ...): add `C:/Program Files/GitHub CLI/gh.exe`.
- Keys `ctrl-alt-1..4/j/n` = **AltGr** on Windows (clashes with `@`, `{`, `€` on some layouts): suggest `ctrl-shift-alt-*` in `keys.json` for Windows.
- `writeStore` uses `renameSync` over an existing file; on Windows this can fail with `EPERM` if the mod is reading the file at that moment. Retry 3x with 25 ms backoff.

---

## 3. Accuracy: Ranch vs. our old `gtpfs-todos`

| Case | Ours | Ranch (unfixed) | Ranch after fixes |
|---|---|---|---|
| One agent, one terminal | Correct | Correct | Correct |
| Session resumed in another terminal | Correct (`claim`) | Empty list | Empty until next write (acceptable) |
| Terminal id reused after restart | Hidden | **Wrong list shown** | Correct (F4) |
| Finished / dead lists | Auto-hidden | Shown forever | Correct (F5) |
| Claude `TaskCreate` ids | Source of truth | Regex (brittle) | Correct (F6) |
| Cancelled tasks | Shown | Dropped | Shown (F7) |
| Sub-agents | Nested | Nested | Nested |
| Remote machines | No | Yes | Yes |

## 4. Suggested order

1. F3 (Settings panel), F4 (wrong list), F5 (cleanup): biggest visible wins.
2. F6, F7, F8, F9: data accuracy.
3. F10, F11, F12: Windows features.
4. F13, F14: polish.
5. Upstream PR for section 1 + F3 so reinstalls don't regress.
