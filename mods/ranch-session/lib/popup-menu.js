// A right-click / context menu shown as a Herdr popup overlay.
// The opener passes plain data (the items), because the popup runs as another
// copy of a mod: RenderMenu draws it from props().menu and runAction performs
// the picked action there. No imports: the gpui-kit/herdr functions are passed
// in, so this file can be copied into every mod (scripts/sync-lib.sh) and its
// logic tested in Node.

/** One clickable row. `action` is plain data: it crosses into the popup's copy
 * of the mod through props, so it cannot be a function.
 * @typedef {{ type: "copy", text: string }
 *   | { type: "run", name: string, args?: Record<string, unknown> }
 *   | { type: "request", key: string, value: object }
 *   | { type: "exec", cmd: string, args: string[], cwd?: string, on?: string }
 *   | { type: "many", actions: Action[] }} Action */

/**
 * @typedef {{ label: string, icon?: string, hint?: string, danger?: boolean,
 *   disabled?: boolean, action: Action } | { separator: true }} MenuItem
 */

export const ROW = 28;
export const SEPARATOR = 9;
export const PAD = 4;
export const MENU_WIDTH = 232;

/** Drops empty entries, leading/trailing separators and repeated separators. */
export function normalizeItems(items) {
  const out = [];
  for (const item of items ?? []) {
    if (!item) continue;
    if (item.separator) {
      if (out.length && !out[out.length - 1].separator) out.push(item);
    } else {
      out.push(item);
    }
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/** The popup size for a menu, border included. */
export function menuSize(items) {
  const list = normalizeItems(items);
  let height = 2 * PAD + 2;
  for (const item of list) height += item.separator ? SEPARATOR : ROW;
  return { width: MENU_WIDTH, height };
}

/** The next row Up/Down lands on: skips separators and disabled rows and wraps
 * around. from = -1 means nothing is selected yet; -1 means nothing selectable. */
export function nextIndex(items, from, dir) {
  const list = normalizeItems(items);
  const n = list.length;
  if (!n) return -1;
  const step = dir < 0 ? -1 : 1;
  let i = from < 0 ? (step < 0 ? 0 : -1) : from;
  for (let k = 0; k < n; k++) {
    i = (i + step + n) % n;
    if (!list[i].separator && !list[i].disabled) return i;
  }
  return -1;
}

/** Shows the menu as a popup at the pointer. `extra` is passed through in
 * props (for example the target the actions apply to). Null when nothing can
 * be picked: no popup is opened. */
export function openMenu({ openOverlay, mod, items, extra }) {
  const menu = normalizeItems(items);
  if (nextIndex(menu, -1, 1) < 0) return null;
  return openOverlay({
    mod,
    kind: "popup",
    frame: "none",
    at: "pointer",
    ...menuSize(menu),
    props: { menu, ...extra },
  });
}

// a request action's nonce: Date.now(), made strictly increasing even for two
// requests in the same millisecond.
let nonce = 0;
function nextNonce() {
  const now = Date.now();
  nonce = now > nonce ? now : nonce + 1;
  return nonce;
}

/** Performs a picked action in the popup's copy of the mod. */
export async function runAction(action, { run, setShared, exec, copy }) {
  switch (action?.type) {
    case "copy":
      return copy(action.text);
    case "run":
      return run(action.name, action.args ?? {});
    case "request":
      return setShared(action.key, { ...action.value, nonce: nextNonce() });
    case "exec": {
      const result = await exec(action.cmd, action.args, { cwd: action.cwd, on: action.on });
      if (result?.code !== 0) {
        throw new Error((result?.stderr ?? "").trim() || `${action.cmd} failed (code ${result?.code})`);
      }
      return result;
    }
    case "many":
      for (const next of action.actions ?? []) await runAction(next, { run, setShared, exec, copy });
      return;
    default:
      throw new Error(`Unknown action: ${action?.type}`);
  }
}

/** Draws the menu; the popup's mod renders this as its root. Indices in
 * `active`/`onPick`/`onHover` are into the normalized items. */
export function renderMenu({ items, active, theme, div, h_flex, v_flex, svg, onPick, onHover }) {
  const t = theme();
  const list = normalizeItems(items);
  const rows = list.map((item, i) => {
    if (item.separator) return div().id(`menu-${i}`).h(1).my(4).w_full().bg(t.border);
    const color = item.danger ? t.ansi1 : item.disabled ? t.dim : t.foreground;
    return h_flex()
      .id(`menu-${i}`)
      .h(ROW)
      .px(8)
      .gap(8)
      .items_center()
      .rounded(5)
      .text_size(12)
      .when(active === i, (el) => el.bg(t.hover))
      .when(!item.disabled, (el) => el.cursor_pointer().on_click((_e, cx) => onPick(i, cx)))
      .on_hover((isIn, cx) => {
        if (isIn && !item.disabled) onHover(i, cx);
      })
      .when(!!item.icon, (el) => el.child(svg(item.icon).size(14).flex_none().text_color(item.danger ? t.ansi1 : t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(item.label))
      .when(!!item.hint, (el) => el.child(div().text_size(11).text_color(t.dim).child(item.hint)));
  });
  return v_flex()
    .size_full()
    .bg(t.popover)
    .border(1)
    .border_color(t.border)
    .rounded(8)
    .p(PAD)
    .text_size(12)
    .children(rows);
}

/** Maps a key event to what a popup menu does with it. */
export function menuKey(key, items, active) {
  const k = String(key ?? "").toLowerCase();
  const list = normalizeItems(items);
  if (k === "up" || k === "arrowup") {
    const i = nextIndex(list, active ?? -1, -1);
    return i < 0 ? {} : { active: i };
  }
  if (k === "down" || k === "arrowdown") {
    const i = nextIndex(list, active ?? -1, 1);
    return i < 0 ? {} : { active: i };
  }
  if (k === "enter") {
    const i = active ?? -1;
    const item = list[i];
    return item && !item.separator && !item.disabled ? { pick: i } : {};
  }
  if (k === "escape") return { close: true };
  return {};
}
