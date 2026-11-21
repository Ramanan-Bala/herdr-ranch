# Session Task Scrolling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap every Session Details Tasks card at five visible rows and make longer lists scroll internally, with a subtle overflow fade and no expansion buttons.

**Architecture:** Keep task ordering, data loading, and progress calculations unchanged. Add a pure layout-height helper in `model.js`, then wrap the existing rows from `tasksCard` in a dedicated GPUI vertical scroll viewport in `main.js`; unique element IDs give each agent an independent scroll region.

**Tech Stack:** JavaScript ES modules, Herdr GPUI (`gpui-kit`, `gpui-base`), Node's built-in test runner, existing Ranch npm scripts.

## Global Constraints

- Show at most five task rows per agent before internal scrolling.
- Five or fewer tasks retain natural height and have no fade.
- Preserve the existing order: ordered non-cancelled tasks followed by cancelled tasks.
- Preserve all existing task-row, progress, activity, lifecycle, and card-collapse behavior.
- Do not add **Show all**, **Show fewer**, persistence, settings, adapters, or task-store changes.
- Use existing theme colors and GPUI primitives only; add no dependencies.
- Follow TDD: add and run the failing regression before implementation.

---

### Task 1: Five-row scroll viewport per Tasks card

**Files:**
- Modify: `mods/ranch-session/model.js` near the existing task helpers (`totalsOf`, `unfinishedCount`).
- Modify: `mods/ranch-session/main.js` near `MAX_FILES`, the model imports, `tasksCard`, and `taskRow`.
- Modify: `test/ranch-session-model.test.js` imports and task-helper tests.

**Interfaces:**
- Consumes: Existing `orderTasks(tasks)`, `RanchSession.liveTasks(tasks)`, and `RanchSession.taskRow(theme, task, address, paused)` behavior.
- Produces: `taskListHeight(taskCount: number): number | null`, returning `null` through five rows and `120` beyond five rows; `RanchSession.taskList(theme, tasks, address, paused)` returning one GPUI element containing all rows.

- [ ] **Step 1: Write the failing layout-threshold regression**

In `test/ranch-session-model.test.js`, add `taskListHeight` to the named imports from `mods/ranch-session/model.js`. Add this test after the `totalsOf and unfinishedCount` test:

```js
test("task lists scroll only beyond five rows", () => {
  assert.equal(taskListHeight(0), null);
  assert.equal(taskListHeight(1), null);
  assert.equal(taskListHeight(5), null);
  assert.equal(taskListHeight(6), 120); // 5 × 20px rows + 4 × 5px gaps
  assert.equal(taskListHeight(50), 120);
});
```

- [ ] **Step 2: Run the regression and confirm it fails**

Run:

```bash
node --test test/ranch-session-model.test.js
```

Expected: FAIL because `taskListHeight` is not exported from `model.js`.

- [ ] **Step 3: Implement the pure height helper**

In `mods/ranch-session/model.js`, immediately before `totalsOf`, add:

```js
export const TASK_LIST_ROW_HEIGHT = 20;
export const TASK_LIST_ROW_GAP = 5;
export const TASK_LIST_VISIBLE_ROWS = 5;

/** Fixed scroll-viewport height for overflowing task lists; natural height otherwise. */
export function taskListHeight(taskCount) {
  return taskCount > TASK_LIST_VISIBLE_ROWS
    ? TASK_LIST_VISIBLE_ROWS * TASK_LIST_ROW_HEIGHT + (TASK_LIST_VISIBLE_ROWS - 1) * TASK_LIST_ROW_GAP
    : null;
}
```

- [ ] **Step 4: Read the UI quality floor immediately before editing the view**

Read `/Users/ramanan/.agents/skills/impeccable/reference/craft-floor.md` in full. This is a quiet Operate-surface refinement: retain the incumbent spacing, colors, typography, and behavior.

- [ ] **Step 5: Add the dedicated scroll viewport and overflow fade**

In `mods/ranch-session/main.js`, import the layout constants alongside the existing `taskEmptyState` import:

```js
  taskEmptyState,
  TASK_LIST_ROW_HEIGHT,
  TASK_LIST_ROW_GAP,
  taskListHeight,
```

Replace the existing direct row loop at the end of `tasksCard`:

```js
    // Cancelled tasks render struck through, after the live ones.
    const cancelled = tasks.filter((x) => x.status === "cancelled");
    for (const task of [...orderTasks(this.liveTasks(tasks)), ...cancelled]) card.child(this.taskRow(t, task, addr, paused));
    return card;
```

with:

```js
    card.child(this.taskList(t, tasks, addr, paused));
    return card;
  }

  /** All tasks in one per-agent viewport; long lists scroll instead of growing the panel. */
  taskList(t, tasks, addr, paused) {
    const cancelled = tasks.filter((x) => x.status === "cancelled");
    const ordered = [...orderTasks(this.liveTasks(tasks)), ...cancelled];
    const height = taskListHeight(ordered.length);
    const rows = v_flex()
      .id(`tasks-list-${addr}`)
      .w_full()
      .gap(TASK_LIST_ROW_GAP)
      .when(height != null, (el) => el.h(height).flex_none().overflow_y_scrollbar())
      .children(ordered.map((task) => this.taskRow(t, task, addr, paused)));
    if (height == null) return rows;

    // Layered surface-color strips provide a quiet fade without adding a control.
    const fade = v_flex()
      .id(`tasks-fade-${addr}`)
      .absolute()
      .left(0)
      .right(0)
      .bottom(0)
      .h(24)
      .children(
        Array.from({ length: 6 }, (_, index) =>
          div().w_full().h(4).bg(t.surface).opacity((index + 1) / 6)
        )
      );
    return v_flex()
      .relative()
      .w_full()
      .h(height)
      .flex_none()
      .child(rows)
      .child(fade);
  }
```

The already existing `taskRow` method follows immediately after this insertion. Change only its row-height declaration from `.h(20)` to `.h(TASK_LIST_ROW_HEIGHT)` so row geometry and viewport geometry share one value.

The `tasks-list-${addr}` and `tasks-fade-${addr}` IDs keep main-agent and sub-agent regions distinct. No button or click handler is added to the fade.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test test/ranch-session-model.test.js test/ranch-session-wiring.test.js
```

Expected: all tests PASS. The new helper passes its threshold regression; existing session wiring remains unchanged.

- [ ] **Step 7: Reload and inspect the rendered desktop panel**

Run:

```bash
npm run reload
screencapture -x /tmp/ranch-session-task-scroll.png
```

Read `/tmp/ranch-session-task-scroll.png`. Use the current Session Details session (it has more than five reported tasks) and inspect it at the shipping panel width. Check that exactly five rows are visible, the fade is subtle, no expansion button appears, the Git section remains directly below the Tasks card, and wheel/trackpad scrolling moves only the hovered agent's task list. If the visual check exposes a defect, correct it and repeat the focused tests and capture before continuing.

- [ ] **Step 8: Run the Impeccable detector once**

Run:

```bash
/Users/ramanan/.agents/skills/impeccable/scripts/impeccable detect --json --changed
```

Expected: no unaddressed detector findings relevant to this scoped change. Report pre-existing or out-of-scope findings separately rather than expanding the patch.

- [ ] **Step 9: Run full repository verification**

Run:

```bash
npm run verify
```

Expected: all tests and checks PASS, including `scripts/sync-lib.sh` and the repository's script checks.

- [ ] **Step 10: Review and commit the implementation**

Run:

```bash
git diff --check
git status --short
git diff -- mods/ranch-session/main.js mods/ranch-session/model.js test/ranch-session-model.test.js
```

Confirm only the scoped implementation and regression are staged, then commit:

```bash
git add mods/ranch-session/main.js mods/ranch-session/model.js test/ranch-session-model.test.js
git commit -m "Session details: scroll long task lists"
```

Expected: one implementation commit; generated synchronized `lib/` copies remain unchanged unless a project script modifies them, in which case inspect rather than blindly staging them.
