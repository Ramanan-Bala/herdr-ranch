// Stashes tab: stash the working tree, list stashes, apply/pop/drop and a
// patch preview. Plain functions over the panel view instance (main.js).
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, Scrollbar } from "gpui-base";
import { relativeTime } from "./lib/format.js";

export function pickStash(view, ref, cx) {
  if (!view.root) return;
  view.selectedStash = ref;
  view.setLines([]);
  const context = view.context;
  cx.spawn(async (cx) => {
    try {
      const r = await view.gitRead(["stash", "show", "-p", "--no-color", ref]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout);
      view.showDiff(r.stdout, () => view.context === context && view.tab === "stashes" && view.selectedStash === ref);
    } catch (e) {
      if (view.context === context) view.note = `Cannot preview this stash: ${view.brief(e?.message ?? e)}`;
    }
    cx.notify();
  });
}

export function renderStashes(view, t, cx) {
  const busy = view.busy;
  const clean = !view.conflicts.length && !view.staged.length && !view.unstaged.length;
  const canStash = Boolean(view.root) && !clean && !busy;
  return v_flex().flex_1().min_h(0).overflow_hidden()
    .child(h_flex().flex_none().px(10).py(6).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().id("stash-message").flex_1().min_w(0).h(28).px(9).flex().items_center().rounded(7)
        .border_1().border_color(t.border).bg(t.input).cursor_text()
        .child(Input.new(view.stashInput).h_full().text_size(12).text_color(t.foreground)))
      .child(div().id("stash").h(28).px(12).flex().flex_none().items_center().rounded(7).text_size(12)
        .when(canStash, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => view.stash(cx)))
        .bg(canStash ? t.solid : t.raised).text_color(canStash ? t.solid_foreground : t.dim)
        .child("Stash")))
    .child(div().flex_1().min_h(44).max_h(Math.max(1, view.stashes.length) * 28 + 12).relative().border_b(1).border_color(t.border)
      .child(v_flex().id("stash-list").absolute().inset_0().overflow_y_scroll().p(6)
        .children(view.stashes.map((stash) => stashRow(view, t, stash, cx)))
        .when(!view.stashes.length, (e) => e.child(div().p(8).text_color(t.dim).child(view.root ? "No stashes" : "No folder"))))
      .child(Scrollbar.vertical("stash-list").absolute().inset_0()))
    .child(view.diffArea(t, cx, view.selectedStash ? null : "Select a stash to view its changes"));
}

function stashRow(view, t, stash, cx) {
  const id = `stash-${stash.ref}`;
  const show = view.hovered === id || view.selectedStash === stash.ref;
  return h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
    .when(view.selectedStash === stash.ref, (e) => e.bg(t.selected))
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => pickStash(view, stash.ref, cx))
    .on_hover((hover, cx) => {
      if (hover && view.hovered !== id) { view.hovered = id; cx.notify(); }
      else if (!hover && view.hovered === id) { view.hovered = null; cx.notify(); }
    })
    .child(div().flex_1().min_w(0).truncate().child(stash.message || stash.ref))
    .when(!show, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${stash.ref} · ${relativeTime(Date.now() - stash.time)}`)))
    .when(show, (e) => e.children([
      view.actionButton(t, `apply-${stash.ref}`, "archive-restore", "Apply",
        (c) => view.mutate("Apply stash", [["stash", "apply", stash.ref]], c)),
      view.actionButton(t, `pop-${stash.ref}`, "check", "Pop",
        (c) => view.mutate("Pop stash", [["stash", "pop", stash.ref]], c)),
      view.discardButton(t, `drop-${stash.ref}`, "Drop?", "Drop stash",
        (c) => view.mutate("Drop stash", [["stash", "drop", stash.ref]], c), cx, "trash-2"),
    ]));
}
