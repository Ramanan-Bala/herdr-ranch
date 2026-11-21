# Session Details: scrollable task lists

## Goal

Keep each agent's Tasks section in Session Details visually capped at five task rows. Longer lists scroll inside that agent's section rather than expanding the whole Session Details panel. Do not add **Show all** or **Show fewer** controls.

## Interaction and visual design

- Apply the same behavior to the main agent and every sub-agent Tasks card.
- Preserve the existing task ordering, row appearance, collapsed-card behavior, progress counts, progress bar, activity text, freshness, and paused states.
- A card with five or fewer tasks keeps its natural list height and has no overflow treatment.
- A card with more than five tasks shows five rows in a fixed-height, vertically scrollable list viewport. The rest of the card and other Session Details sections stay in place while that list scrolls.
- Use a subtle surface-colored bottom fade as the overflow cue. It is decorative, not a button, and must not intercept wheel or pointer interaction with task rows. Do not add a separate expansion control.
- Each Tasks card owns its scroll position independently; scrolling one agent's list does not scroll another agent's list or the outer panel.

## Implementation shape

Change `mods/ranch-session/main.js` at the point where `tasksCard` appends task rows. Put the rows in a dedicated vertical flex container instead of directly in the card. For lists longer than five, constrain that container to the height of five existing rows, including their existing gaps, and enable vertical scrolling. Keep the existing `orderTasks(liveTasks(...))` plus cancelled-task ordering unchanged.

Use the existing theme surface color for the fade and existing GPUI layout primitives. Keep all task data and progress calculations based on the complete list; only the list viewport is constrained. No task-store, persistence, settings, adapter, or public-model changes are needed.

## Edge cases

- Empty, loading, ended, stale, invalid, and collapsed states return before the list viewport and remain unchanged.
- Exactly five tasks do not need a scrollbar or fade.
- Cancelled tasks count toward the five visible rows because they remain part of the displayed ordered list.
- Live task updates preserve the same full-list rendering path and do not reset any other card's state.
- Panel resizing keeps the existing row truncation behavior; the fixed constraint applies only to list height.

## Verification

Add focused regression coverage for the five-row threshold and rendering structure, using the existing Node test approach with GPUI stubs. Verify zero, five, and six-plus tasks, cancelled-task inclusion, independent per-card containers, and unchanged full-list progress. Run the Ranch session tests and the repository verification script. Inspect the rendered panel at its shipping panel width, including a list longer than five rows, and run the Impeccable detector once after the UI edits.
