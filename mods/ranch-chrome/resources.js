import { div, svg } from "gpui-kit";
import { Checkbox, Tab, Tabs, h_flex, v_flex } from "gpui-base";
import { run, spaces } from "herdr";
import {
  buildResourceTree,
  buildTerminalInventory,
  formatMemory,
  readHistory,
} from "./lib/sysstats.js";

const ICON_MEMORY = "mods/ranch-chrome/memory-stick.svg";
const ICON_CHEVRON_DOWN = "mods/ranch-chrome/chevron-down.svg";
const ICON_CHEVRON_RIGHT = "mods/ranch-chrome/chevron-right.svg";
const ICON_CHECK = "mods/ranch-chrome/check.svg";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatStarted(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const now = new Date();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return time;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

function sparkline(t, history) {
  const samples = (history ?? []).slice(-24);
  const max = Math.max(...samples, 1);
  return h_flex().w(71).h(12).flex_none().gap(1).items_end().justify_end()
    .children(samples.map((s) => {
      const h = s > 0 ? Math.max(2, Math.round((s / max) * 12)) : 1;
      return div().w(2).h(h).rounded(1).bg(s > 0 ? t.accent : t.border);
    }));
}

function smallButton(t, id, label, opts, onClick) {
  const { danger = false, disabled = false, muted = false } = opts ?? {};
  const fg = disabled ? t.dim : danger ? t.blocked : muted ? t.muted : t.foreground;
  return div().id(id).px(7).py(2).rounded(5).bg(t.raised).border_1().border_color(t.border)
    .text_size(11).text_color(fg).flex_none()
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      }))
    .child(label);
}

function agentChip(t) {
  return div().px(4).py(1).rounded(3).bg(t.raised).flex_none()
    .text_size(9.5).text_color(t.working).child("agent");
}

function checkIndicator(t, checked) {
  return div().size(13).flex_none().rounded(3).border_1()
    .border_color(checked ? t.accent : t.border)
    .bg(checked ? t.accent : t.raised)
    .flex().items_center().justify_center()
    .when(checked, (el) => el.child(svg(ICON_CHECK).size(9).text_color(t.accent_foreground ?? t.foreground)));
}

function inlineConfirm(t, idPrefix, prompt, onConfirm, onCancel, confirmLabel = "Yes", cancelLabel = "No") {
  return h_flex().flex_none().gap(5).items_center()
    .when(Boolean(prompt), (el) => el.child(div().text_size(11).text_color(t.muted).child(prompt)))
    .child(div().id(`${idPrefix}-yes`).px(6).py(1).rounded(4).bg(t.raised)
      .text_size(11).font_semibold().text_color(t.blocked).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onConfirm(cx);
      })
      .child(confirmLabel))
    .child(div().id(`${idPrefix}-no`).px(6).py(1).rounded(4).bg(t.raised)
      .text_size(11).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onCancel(cx);
      })
      .child(cancelLabel));
}

function killAddresses(addresses) {
  for (const addr of addresses) {
    if (typeof addr === "string" && addr) run("terminal.kill", { terminal: addr });
  }
}

function closePopover(view, cx) {
  view.resOpen = false;
  view.confirmKill = null;
  view.hoveredRow = null;
  cx.notify();
}

function renderSummary(t, stats) {
  const split = stats.split ?? { herdr: 0, agents: 0, other: 0 };
  const total = (split.herdr || 0) + (split.agents || 0) + (split.other || 0);
  const orphanCount = stats.orphanAddresses?.size ?? 0;

  const ownerItem = (id, color, label, kb) => h_flex().id(id).gap(5).items_center().min_w(0)
    .child(div().size(8).flex_none().rounded(2).bg(color))
    .child(div().text_size(11).text_color(t.muted).child(label))
    .child(div().text_size(11).font_semibold().text_color(t.foreground).child(formatMemory(kb)));

  const segs = [
    { id: "sb-res-bar-herdr", val: split.herdr || 0, color: t.accent },
    { id: "sb-res-bar-agents", val: split.agents || 0, color: t.working },
    { id: "sb-res-bar-other", val: split.other || 0, color: t.dim },
  ].filter((s) => total > 0 && s.val > 0);

  return v_flex().id("sb-res-summary").w_full().gap(6)
    .child(h_flex().w_full().gap(10).items_center().justify_between()
      .child(ownerItem("sb-res-own-herdr", t.accent, "Herdr", split.herdr))
      .child(ownerItem("sb-res-own-agents", t.working, "Agents", split.agents))
      .child(ownerItem("sb-res-own-other", t.dim, "Other terminals", split.other)))
    .child(h_flex().w_full().h(6).rounded(3).bg(t.raised).overflow_hidden()
      .children(segs.map((s) => div().id(s.id).h_full().w(`${(s.val / total) * 100}%`).bg(s.color))))
    .when(orphanCount > 0, (el) => el.child(h_flex().w_full().justify_end()
      .child(div().id("sb-res-summary-orphans").text_size(11).text_color(t.blocked)
        .child(`${orphanCount} orphan${orphanCount === 1 ? "" : "s"}`))));
}

function renderTreeTerminalRow(view, t, tm) {
  const addr = tm.address ?? "";
  const confirmKey = `row:${addr}`;
  const confirming = view.confirmKill === confirmKey;
  const hovered = view.hoveredRow === addr;
  const label = tm.label || addr;

  return h_flex().id(`sb-res-row-${addr}`).w_full().h(24).pl(26).pr(4).gap(6).items_center().rounded(5)
    .when(!confirming && tm.bound && tm.tab, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        run("tab.select", { id: tm.tab });
        closePopover(view, cx);
      }))
    .when(!confirming && !(tm.bound && tm.tab), (el) => el.hover((s) => s.bg(t.hover)))
    .on_hover((isIn, cx) => {
      const next = isIn ? addr : (view.hoveredRow === addr ? null : view.hoveredRow);
      if (view.hoveredRow !== next) {
        view.hoveredRow = next;
        cx.notify();
      }
    })
    .child(div().size(6).flex_none().rounded_full().bg(tm.bound ? t.done : t.dim))
    .when(tm.agent, (el) => el.child(agentChip(t)))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(label))
    .when(confirming, (el) => el.child(inlineConfirm(
      t,
      `sb-res-row-${addr}`,
      "End?",
      (cx) => {
        view.confirmKill = null;
        if (addr) run("terminal.kill", { terminal: addr });
        cx.notify();
      },
      (cx) => {
        view.confirmKill = null;
        cx.notify();
      },
    )))
    .when(!confirming, (el) => el
      .child(sparkline(t, tm.history))
      .child(div().w(42).flex_none().flex().justify_end().text_size(11.5).text_color(t.muted).child(`${Math.round(tm.cpu)}%`))
      .child(div().w(58).flex_none().flex().justify_end().text_size(11.5).text_color(t.foreground).child(formatMemory(tm.rssKB)))
      .child(div().id(`sb-res-kill-${addr}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
        .when(hovered, (btn) => btn.cursor_pointer().text_size(13).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            view.confirmKill = confirmKey;
            cx.notify();
          })
          .child("×"))));
}

function renderCollapsibleGroupRow(view, t, opts) {
  const { id, collapseKey, indent, name, history, cpu, rssKB, muted = false } = opts;
  const collapsed = view.collapsed.has(collapseKey);
  return h_flex().id(id).w_full().h(24).pl(indent).pr(4).gap(6).items_center().rounded(5)
    .cursor_pointer().hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => {
      if (view.collapsed.has(collapseKey)) view.collapsed.delete(collapseKey);
      else view.collapsed.add(collapseKey);
      cx.notify();
    })
    .child(svg(collapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN).size(10).flex_none().text_color(t.dim))
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold()
      .text_color(muted ? t.muted : t.foreground).child(name))
    .child(sparkline(t, history))
    .child(div().w(42).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(`${Math.round(cpu)}%`))
    .child(div().w(58).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(formatMemory(rssKB)))
    .child(div().w(18).flex_none());
}

function renderResourcesTab(view, t, stats) {
  if (!stats) {
    return [div().py(8).text_color(t.dim).child("Loading…")];
  }

  const out = [renderSummary(t, stats)];

  const sortCol = (key, text) => {
    const active = view.resSort === key;
    return div().id(`sb-res-sort-${key}`).text_size(11).cursor_pointer()
      .text_color(active ? t.foreground : t.muted)
      .when(active, (el) => el.font_semibold())
      .hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        view.resSort = key;
        cx.notify();
      })
      .child(text);
  };

  out.push(h_flex().w_full().gap(6).pb(4).border_b(1).border_color(t.border).items_center()
    .child(div().flex_1().min_w(0).child(sortCol("name", "Name")))
    .child(div().w(71).flex_none())
    .child(div().w(42).flex_none().flex().justify_end().child(sortCol("cpu", "CPU")))
    .child(div().w(58).flex_none().flex().justify_end().child(sortCol("memory", "Memory")))
    .child(div().w(18).flex_none()));

  const tree = buildResourceTree({
    rows: stats.rows,
    spaces: spaces(),
    history: view.history,
    sort: view.resSort,
    agentAddresses: stats.agentAddresses,
    orphanAddresses: stats.orphanAddresses,
  });

  if (tree.spaces.length === 0 && tree.orphans.length === 0) {
    out.push(div().py(8).text_color(t.dim).child("Nothing running right now"));
  } else {
    for (const sp of tree.spaces) {
      const spKey = `space:${sp.id ?? "background"}`;
      const spCollapsed = view.collapsed.has(spKey);
      const spSection = v_flex().w_full().gap(1)
        .child(renderCollapsibleGroupRow(view, t, {
          id: `sb-res-space-${sp.id ?? "background"}`,
          collapseKey: spKey,
          indent: 4,
          name: sp.name,
          history: sp.history,
          cpu: sp.cpu,
          rssKB: sp.rssKB,
        }));
      if (!spCollapsed) {
        for (const tb of sp.tabs) {
          const tbKey = `tab:${tb.id ?? "background"}`;
          const tbCollapsed = view.collapsed.has(tbKey);
          spSection.child(renderCollapsibleGroupRow(view, t, {
            id: `sb-res-tab-${tb.id ?? "background"}`,
            collapseKey: tbKey,
            indent: 14,
            name: tb.name,
            history: tb.history,
            cpu: tb.cpu,
            rssKB: tb.rssKB,
            muted: true,
          }));
          if (!tbCollapsed) {
            spSection.children(tb.terminals.map((tm) => renderTreeTerminalRow(view, t, tm)));
          }
        }
      }
      out.push(spSection);
    }
    if (tree.orphans.length > 0) {
      const orphansKey = "orphans";
      const orphansCollapsed = view.collapsed.has(orphansKey);
      let orphanCpu = 0;
      let orphanRssKB = 0;
      for (const tm of tree.orphans) {
        orphanCpu += tm.cpu || 0;
        orphanRssKB += tm.rssKB || 0;
      }
      const orphanSection = v_flex().w_full().gap(1)
        .child(renderCollapsibleGroupRow(view, t, {
          id: "sb-res-orphans-group",
          collapseKey: orphansKey,
          indent: 4,
          name: "Orphan terminals",
          history: [],
          cpu: orphanCpu,
          rssKB: orphanRssKB,
          muted: true,
        }));
      if (!orphansCollapsed) {
        orphanSection.children(tree.orphans.map((tm) => renderTreeTerminalRow(view, t, tm)));
      }
      out.push(orphanSection);
    }
  }

  if (stats.herdr && stats.herdr.count > 0) {
    const herdrKey = "herdr";
    const herdrCollapsed = view.collapsed.has(herdrKey);
    const herdrSection = v_flex().w_full().gap(1).pt(6).border_t(1).border_color(t.border)
      .child(renderCollapsibleGroupRow(view, t, {
        id: "sb-res-herdr",
        collapseKey: herdrKey,
        indent: 4,
        name: "Herdr",
        history: readHistory(view.history, "herdr"),
        cpu: stats.herdr.cpu,
        rssKB: stats.herdr.rssKB,
        muted: true,
      }));
    if (!herdrCollapsed) {
      const subRow = (id, label, bucket) => h_flex().id(id).w_full().h(22).pl(24).pr(4).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(label))
        .child(div().w(71).flex_none())
        .child(div().w(42).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(`${Math.round(bucket.cpu)}%`))
        .child(div().w(58).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(formatMemory(bucket.rssKB)))
        .child(div().w(18).flex_none());
      herdrSection
        .child(subRow("sb-res-herdr-app", "App", stats.herdr.app))
        .child(subRow("sb-res-herdr-core", "Core", stats.herdr.core));
    }
    out.push(herdrSection);
  }

  if ((stats.other?.count ?? 0) > 0) {
    out.push(h_flex().id("sb-res-other").w_full().px(4).pt(6).gap(6).items_center()
      .border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child("Other Herdr processes"))
      .child(div().w(71).flex_none())
      .child(div().w(42).flex_none().flex().justify_end().text_size(11.5).text_color(t.muted).child(`${Math.round(stats.other.cpu)}%`))
      .child(div().w(58).flex_none().flex().justify_end().text_size(11.5).text_color(t.muted).child(formatMemory(stats.other.rssKB)))
      .child(div().w(18).flex_none()));
  }

  const orphanCount = stats.orphanAddresses?.size ?? 0;
  if (orphanCount > 0) {
    const confirmingOrphans = view.confirmKill === "__orphans__";
    const orphanLabel = `${orphanCount} orphan terminal${orphanCount === 1 ? "" : "s"}`;
    out.push(h_flex().id("sb-res-orphans-footer").w_full().pt(8).border_t(1).border_color(t.border)
      .items_center().justify_between().gap(8)
      .when(!confirmingOrphans, (el) => el
        .child(smallButton(t, "sb-res-end-orphans", `End ${orphanLabel}`, { danger: true }, (cx) => {
          view.confirmKill = "__orphans__";
          cx.notify();
        })))
      .when(confirmingOrphans, (el) => el.child(inlineConfirm(
        t,
        "sb-res-orphans",
        `End ${orphanLabel}?`,
        (cx) => {
          const addrs = [...(stats.orphanAddresses ?? [])];
          view.confirmKill = null;
          killAddresses(addrs);
          cx.notify();
        },
        (cx) => {
          view.confirmKill = null;
          cx.notify();
        },
      ))));
  }

  if (Array.isArray(stats.ports) && stats.ports.length > 0) {
    out.push(v_flex().id("sb-res-ports").w_full().gap(4).pt(8).border_t(1).border_color(t.border)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child("Listening ports"))
      .children(stats.ports.map((p) => div().id(`sb-res-port-${p.port}`).px(4).text_size(11.5).text_color(t.muted)
        .child(`:${p.port}  ${p.command}`))));
  }

  return out;
}

function detailLine(t, id, label, value) {
  return h_flex().id(id).w_full().gap(8).items_start()
    .child(div().w(116).flex_none().text_size(11).text_color(t.muted).child(label))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(value));
}

function renderTerminalDetails(t, it) {
  const addr = it.address ?? "unknown";
  const fg = it.foreground
    ? (it.foregroundPid != null ? `${it.foreground} (${it.foregroundPid})` : it.foreground)
    : (it.foregroundPid != null ? String(it.foregroundPid) : "—");
  const tabStr = it.bound
    ? `${it.spaceName ?? "Space"} / ${it.tabName ?? it.tabId}`
    : "No tab";

  return v_flex().id(`sb-res-term-details-${addr}`).w_full().pl(24).pr(6).py(6).gap(3)
    .rounded(5).bg(t.raised)
    .child(detailLine(t, `sb-res-term-d-addr-${addr}`, "Address", it.address ?? "—"))
    .child(detailLine(t, `sb-res-term-d-pid-${addr}`, "PID", it.pid != null ? String(it.pid) : "—"))
    .child(detailLine(t, `sb-res-term-d-fg-${addr}`, "Foreground process", fg))
    .child(detailLine(t, `sb-res-term-d-cwd-${addr}`, "Working folder", it.cwd ?? "—"))
    .child(detailLine(t, `sb-res-term-d-tab-${addr}`, "Tab", tabStr))
    .child(detailLine(t, `sb-res-term-d-parent-${addr}`, "Parent", it.parent ?? "—"))
    .child(detailLine(t, `sb-res-term-d-agent-${addr}`, "Agent", it.agent ?? "—"))
    .child(detailLine(t, `sb-res-term-d-status-${addr}`, "Status", it.status ?? (it.alive ? "live" : "—")))
    .child(detailLine(t, `sb-res-term-d-started-${addr}`, "Started", formatStarted(it.createdMs)))
    .child(detailLine(t, `sb-res-term-d-mem-${addr}`, "Memory", formatMemory(it.rssKB)))
    .child(detailLine(t, `sb-res-term-d-cpu-${addr}`, "CPU", `${Math.round(it.cpu)}%`));
}

function renderTerminalsTab(view, t, stats) {
  if (!stats) {
    return [div().py(8).text_color(t.dim).child("Loading…")];
  }

  const inv = buildTerminalInventory({
    terminals: stats.terminals,
    details: view.pidCache,
    rows: stats.rows,
    spaces: spaces(),
    orphanAddresses: stats.orphanAddresses,
  });

  if (inv.items.length === 0) {
    return [div().py(8).text_color(t.dim).child("No local terminals")];
  }

  const selectable = inv.items.map((it) => it.address).filter(Boolean);
  const selectedCount = selectable.filter((a) => view.selected.has(a)).length;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  const confirmingSelected = view.confirmKill === "__selected__";

  const out = [];
  out.push(div().id("sb-res-term-summary").text_size(11).text_color(t.muted)
    .child(`${inv.count} terminal${inv.count === 1 ? "" : "s"} on this computer · ${inv.withoutTab} without a tab · Last observed ${formatClock(stats.observedAt)}`));

  out.push(h_flex().id("sb-res-term-controls").w_full().py(4).border_b(1).border_color(t.border)
    .items_center().justify_between().gap(8)
    .child(Checkbox.new("sb-res-term-select-all").checked(allSelected)
      .flex().items_center().gap(6).cursor_pointer()
      .on_change((checked, cx) => {
        if (checked) {
          for (const a of selectable) view.selected.add(a);
        } else {
          view.selected.clear();
          if (view.confirmKill === "__selected__") view.confirmKill = null;
        }
        cx.notify();
      })
      .child(checkIndicator(t, allSelected))
      .child(div().text_size(11.5).text_color(t.foreground).child("Select all")))
    .when(!confirmingSelected, (el) => el.child(smallButton(
      t,
      "sb-res-term-end-selected",
      `End selected (${selectedCount})`,
      { danger: selectedCount > 0, disabled: selectedCount === 0 },
      (cx) => {
        view.confirmKill = "__selected__";
        cx.notify();
      },
    )))
    .when(confirmingSelected, (el) => el.child(inlineConfirm(
      t,
      "sb-res-term-sel",
      `End ${selectedCount}?`,
      (cx) => {
        const addrs = selectable.filter((a) => view.selected.has(a));
        view.confirmKill = null;
        view.selected.clear();
        killAddresses(addrs);
        cx.notify();
      },
      (cx) => {
        view.confirmKill = null;
        cx.notify();
      },
    ))));

  for (let i = 0; i < inv.items.length; i++) {
    const it = inv.items[i];
    const addr = it.address ?? String(i);
    const checked = Boolean(it.address && view.selected.has(it.address));
    const expanded = Boolean(it.address && view.expanded.has(it.address));
    const confirmKey = `term:${addr}`;
    const confirming = view.confirmKill === confirmKey;

    const row = h_flex().id(`sb-res-term-row-${addr}`).w_full().h(26).px(4).gap(6).items_center().rounded(5)
      .hover((s) => s.bg(t.hover))
      .child(Checkbox.new(`sb-res-term-chk-${addr}`).checked(checked)
        .flex().items_center().justify_center().cursor_pointer()
        .on_change((next, cx) => {
          if (!it.address) return;
          if (next) view.selected.add(it.address);
          else view.selected.delete(it.address);
          cx.notify();
        })
        .child(checkIndicator(t, checked)))
      .child(div().size(6).flex_none().rounded_full().bg(it.alive ? t.done : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(it.title || addr))
      .when(Boolean(it.agent), (el) => el.child(agentChip(t)))
      .child(div().w(54).flex_none().flex().justify_end().text_size(11.5).text_color(t.foreground).child(formatMemory(it.rssKB)))
      .when(confirming, (el) => el.child(inlineConfirm(
        t,
        `sb-res-term-${addr}`,
        "End?",
        (cx) => {
          view.confirmKill = null;
          if (it.address) run("terminal.kill", { terminal: it.address });
          cx.notify();
        },
        (cx) => {
          view.confirmKill = null;
          cx.notify();
        },
      )))
      .when(!confirming, (el) => el
        .child(smallButton(t, `sb-res-term-goto-${addr}`, "Go to", { muted: true }, (cx) => {
          if (it.bound && it.tabId) run("tab.select", { id: it.tabId });
          else if (it.address) run("agent.focus", { terminal: it.address });
          closePopover(view, cx);
        }))
        .child(smallButton(t, `sb-res-term-end-${addr}`, "End", { danger: true }, (cx) => {
          view.confirmKill = confirmKey;
          cx.notify();
        })))
      .child(div().id(`sb-res-term-exp-${addr}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (!it.address) return;
          if (view.expanded.has(it.address)) view.expanded.delete(it.address);
          else view.expanded.add(it.address);
          cx.notify();
        })
        .child(svg(expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT).size(10).text_color(t.muted)));

    out.push(v_flex().w_full().gap(2)
      .child(row)
      .when(expanded, (el) => el.child(renderTerminalDetails(t, it))));
  }

  return out;
}

export function renderResourcePopover(view, t, stats) {
  try {
    const vh = globalThis.window?.viewport_size?.()?.height;
    const popMaxH = Number.isFinite(vh) && vh > 0 ? Math.min(560, Math.max(220, vh - 56)) : 560;
    const localTerms = stats?.terminals ?? [];
    const termCount = localTerms.length;
    const confirmingAll = view.confirmKill === "__all__";
    const bodyMaxH = Math.max(120, popMaxH - (confirmingAll ? 124 : 84));

    const header = h_flex().id("sb-res-header").w_full().px(12).pt(10).pb(8).gap(8)
      .items_center().justify_between().flex_none()
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(svg(ICON_MEMORY).size(14).flex_none().text_color(t.muted))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Resource Manager")))
      .child(h_flex().gap(6).items_center().flex_none()
        .child(smallButton(t, "sb-res-refresh", "Refresh", { muted: true }, (cx) => {
          if (view.resTab === "terminals") view.refreshDetails = true;
          view.pollStats(cx);
          cx.notify();
        }))
        .child(smallButton(
          t,
          "sb-res-end-all",
          "End all",
          { danger: termCount > 0, disabled: termCount === 0 },
          (cx) => {
            view.confirmKill = "__all__";
            cx.notify();
          },
        )));

    const endAllBar = confirmingAll
      ? h_flex().id("sb-res-end-all-bar").w_full().px(12).py(8).gap(8).flex_none()
          .bg(t.raised).border_t(1).border_b(1).border_color(t.border).items_center().justify_between()
          .child(div().flex_1().min_w(0).text_size(11).text_color(t.foreground)
            .child(`End all ${termCount} terminal${termCount === 1 ? "" : "s"}? This closes every local terminal, including this one's agents.`))
          .child(inlineConfirm(
            t,
            "sb-res-end-all",
            null,
            (cx) => {
              const addrs = localTerms.map((tm) => tm.address).filter(Boolean);
              view.confirmKill = null;
              killAddresses(addrs);
              cx.notify();
            },
            (cx) => {
              view.confirmKill = null;
              cx.notify();
            },
            "End all",
            "Cancel",
          ))
      : null;

    const tabStyle = (tab, active) => tab.px(10).py(6).text_size(12).cursor_pointer()
      .border_b(2).border_color(active ? t.accent : t.popover)
      .text_color(active ? t.foreground : t.muted)
      .when(active, (el) => el.font_semibold())
      .hover((s) => s.text_color(t.foreground));

    const isResources = view.resTab !== "terminals";
    const tabStrip = Tabs.new("sb-res-tabs").flex().w_full().px(12).gap(6).flex_none()
      .border_b(1).border_color(t.border)
      .child(tabStyle(Tab.new("sb-res-tab-resources"), isResources)
        .selected(isResources).set_position(1, 2)
        .on_click((_e, cx) => {
          view.resTab = "resources";
          view.confirmKill = null;
          cx.notify();
        })
        .child("Resources"))
      .child(tabStyle(Tab.new("sb-res-tab-terminals"), !isResources)
        .selected(!isResources).set_position(2, 2)
        .on_click((_e, cx) => {
          view.resTab = "terminals";
          view.confirmKill = null;
          cx.notify();
        })
        .child(h_flex().gap(5).items_center()
          .child("Terminals")
          .when(stats != null, (el) => el.child(div().px(5).py(1).rounded(8).bg(t.raised)
            .text_size(10.5).text_color(t.muted).child(String(termCount))))));

    const bodyChildren = isResources
      ? renderResourcesTab(view, t, stats)
      : renderTerminalsTab(view, t, stats);

    const body = v_flex().id("sb-res-scroll").w_full().max_h(bodyMaxH).overflow_y_scrollbar()
      .p(12).gap(8).children(bodyChildren);

    return v_flex().id("sb-res-popover").w(420).max_h(popMaxH).rounded(10).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().text_size(12).text_color(t.foreground).overflow_hidden()
      .child(header)
      .when(Boolean(endAllBar), (el) => el.child(endAllBar))
      .child(tabStrip)
      .child(body);
  } catch {
    return v_flex().id("sb-res-popover").w(420).p(12).rounded(10).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().text_size(12).text_color(t.dim)
      .child("Unable to render Resource Manager");
  }
}
