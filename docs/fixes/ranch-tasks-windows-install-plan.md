# Plan: make `ranch-tasks` installable on Windows

Goal: `ranch-tasks install`, `status`, `uninstall`, `gc` and the Ranch Settings *Set up* button work on Windows with no manual patching, and stay identical on macOS/Linux.

Status today: works on this machine only because of a local patch (see `ranch-fixes.md` section 1). Upstream `main` (`6662a24`) still fails.

---

## 1. Why it fails today

| # | Step | What happens on Windows | Root cause |
|---|---|---|---|
| 1 | `install`: copy runtime to `~/.herdr/ranch/bin` | Writes `ranch-tasks` (a `#!/bin/sh` launcher) + `ranch-tasks.js` | Launcher is POSIX-only; Windows has no shebang support |
| 2 | `install`: write Claude/Codex hooks | Command `C:\...\ranch-tasks claude` | Windows can't execute the sh launcher; backslashes |
| 3 | `install`: back up AGENTS/CLAUDE files | Crash `ENOENT` | `path.split("/")` on a `\` path |
| 4 | `status` / `uninstall` / reinstall | Hooks reported *missing*, duplicated, not removed | `isRanchGroup()` matches `/.herdr/ranch/bin/ranch-tasks` (forward slashes only) |
| 5 | Settings panel / *Set up* button | Error / nothing happens | Mods `exec()` the sh launcher directly |
| 6 | `gc` | Works only if `hc` is on PATH | Fine (hc is on PATH via Herdr) |

---

## 2. Design

One rule: **on Windows always call `node <abs>/ranch-tasks.js <args>` with forward-slash paths.** Keep the sh launcher for macOS/Linux (it finds node under nvm/volta).

Why not a `ranch-tasks.cmd` shim instead?
- Pro: one command name on every OS.
- Con: hooks then depend on `cmd.exe` quoting rules, `%` expansion in args, and the mods would still need `.cmd` handling (`exec` can't start `.cmd` without `cmd /c`).
- Decision: `node` + `.js` path. Node is already required by the installer. Optional `.cmd` shim only for humans typing `ranch-tasks` in a terminal (phase 3).

---

## 3. Phases

### Phase 1: Installer (`adapters/install.js`), already prototyped locally
1. Add `hookCommand(agent)`: win32 → `node "<home>/.herdr/ranch/bin/ranch-tasks.js" <agent>` with `\` replaced by `/`; else current command.
2. Use it in `installClaude` and `installCodex`.
3. Backup label: `f.path.split(/[\\/]/)`.
4. `isRanchGroup()`: normalize before matching, so old backslash hooks from a failed install are also recognized and cleaned:
   ```js
   const norm = (c) => String(c ?? "").replace(/\\/g, "/");
   // match norm(command).includes(RANCH_MARK)
   ```
5. `statusSummary()`: report `"broken"` (not `"missing"`) when a Ranch hook exists whose command can't run on this OS (backslash path or no `node` prefix on win32), so the Settings panel can offer *Repair*.
6. `installClaude`/`installCodex`: before adding, remove Ranch groups matched by the normalized check, so reinstall migrates broken hooks instead of duplicating them.

### Phase 2: Mods (`ranch-settings`, `ranch-session`)
1. Shared helper in `lib/` (synced to mods by `scripts/sync-lib.sh`):
   ```js
   export function tasksCommand(home, args, isWin) {
     return isWin
       ? ["node", [`${home}/.herdr/ranch/bin/ranch-tasks.js`, ...args]]
       : [`${home}/.herdr/ranch/bin/ranch-tasks`, args];
   }
   ```
2. Use it at `ranch-settings/main.js` lines 64, 89 and `ranch-session/main.js` lines 312, 331.
3. Detect Windows: platform value from the Herdr mod API if present; else `home()` matches `/^[A-Za-z]:/`. For remote machines, decide by the remote `homeFor()` result.
4. Show `"broken"` status as a *Repair* button that runs `install --yes`.

### Phase 3: Convenience (optional)
1. Write `~/.herdr/ranch/bin/ranch-tasks.cmd`: `@node "%~dp0ranch-tasks.js" %*`.
2. Print a hint to add `~/.herdr/ranch/bin` to PATH (do not edit PATH automatically).

### Phase 4: Tests + CI
1. `test/install.test.js`: run install with `RANCH_HOME` = temp dir, and mock `process.platform` = `win32` (inject a `platform` param into `hookCommand` instead of reading the global, so it is testable). Assert:
   - hook command starts with `node "` and contains no `\`;
   - backup names have no `:` or `\`;
   - second install adds no duplicates;
   - uninstall removes all Ranch hooks, including legacy backslash ones (fixture).
2. `test/tasks-command.test.js` for the lib helper (both OSes).
3. Add a `windows-latest` job to CI running `node --test`.
4. `scripts/check.sh` → also a `check.mjs` (or run via Git bash in CI) so contributors on Windows can run checks.

### Phase 5: Docs
1. RECIPE/README: Windows requirements: Node on PATH; Git for Windows (`sh`) for the usage panel; Codex needs `/hooks` approval once.
2. Note that `ctrl-alt` keys are AltGr on Windows.

---

## 4. Verification checklist (Windows)

Run in a fresh PowerShell after each phase:

```powershell
# install from the repo
node bin/ranch-tasks install --yes
node $HOME/.herdr/ranch/bin/ranch-tasks.js status --json        # all "installed"
Select-String -Path $HOME/.claude/settings.json, $HOME/.codex/hooks.json -Pattern 'ranch-tasks' # node "C:/.../ranch-tasks.js"
node bin/ranch-tasks install --yes                              # run twice: no duplicate groups
# hook smoke test
$env:HC_TERMINAL_ID='tverify'
'{"hook_event_name":"PostToolUse","tool_name":"TodoWrite","session_id":"s1","tool_input":{"todos":[{"content":"a","status":"in_progress","activeForm":"A"}]}}' | node $HOME/.herdr/ranch/bin/ranch-tasks.js claude
Get-Content $HOME/.herdr/ranch/tasks/tverify.json               # one task, status in_progress
Remove-Item $HOME/.herdr/ranch/tasks/tverify.json
# Herdr: Ranch Settings -> Task reporting rows show "installed"; Set up/Repair works
node bin/ranch-tasks uninstall --yes                            # hooks gone, AGENTS/CLAUDE blocks removed
```

Pass criteria: no errors, no duplicate hooks, uninstall leaves files equal to the pre-install backups (except unrelated user edits).

## 5. Rollback

- Ranch backups: `~/.herdr/ranch/backups/` (written by install).
- Our backups: `~/.config/herdr-app-backup-20261111-185916/agent-configs/`.
- `node ~/.herdr/ranch/bin/ranch-tasks.js uninstall --yes` (works on this machine thanks to the local patch).

## 6. Effort (human + AI)

| Phase | Size |
|---|---|
| 1 Installer | ~1 h (mostly done locally) |
| 2 Mods | ~1 h |
| 3 Shim | 15 min |
| 4 Tests + CI | 1-2 h (Windows runner time) |
| 5 Docs | 15 min |
