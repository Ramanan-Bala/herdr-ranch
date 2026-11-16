// The Ranch files pane, in four modes:
//  - the panel: a lazy file tree for the focused pane's folder with git marks
//    and right-click menus. Clicking a file opens it in the viewer tab;
//  - props().viewer: the viewer tab's copy (a Herdr tab whose only pane is
//    this mod, shown in the top bar as a closable tab). One thing at a time:
//    whatever shared(VIEWER_KEY) names (lib/file-viewer.js) — a file, or with
//    `diff` set, that file's git changes (opened from the Changes panel);
//  - props().file: a full-size viewer split beside a terminal;
//  - props().menu: the popup menu copy that runs a picked action.
// Previews stay bounded (400000 chars, binary detection) and read-only.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, props, openOverlay, closeOverlay, shared, setShared } from "herdr";
import { EdgeGrip } from "./lib/edge-grip.js";
import { openMenu, renderMenu, runAction, menuKey, nextIndex } from "./lib/popup-menu.js";
import { fileIcon, folderIcon, iconPath, languageFor } from "./lib/file-icons.js";
import { VIEWER_KEY, viewerRequest, stableLocation } from "./lib/file-viewer.js";
import { diffRows, diffWidth, diffStats, hunkLines, addedLines, diffArgs } from "./lib/diff.js";
import { treeMarks, viewerBreadcrumbs, parentPath, previewText, lineCount } from "./view-model.js";

// The last terminal location per space: a focused mod pane (the file viewer
// tab) has no folder, and must not re-root this panel (lib/file-viewer.js).
const lastLocation = new Map();
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return stableLocation({ cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id }, pane, lastLocation);
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;
const REQUEST_KEY = "ranch.files.request";
const markColor = (mark, t) => mark === "A" ? t.ansi2 : mark === "M" ? t.blocked : t.ansi1;
const GONE = "This file is no longer available";
// Git reads that write nothing under .git (no index refresh, lock or fsmonitor cookie).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const GROUP_LABEL = { staged: "Staged", unstaged: "Changes", conflicts: "Conflict" };

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.wrap = shared("ranch.files.wrap") === true;
    this.copied = false; this.copyToken = 0;
    const p = props() ?? {};
    if (Array.isArray(p.menu)) {
      this.mode = "menu";
      this.handle = cx.focus_handle();
      this.active = nextIndex(p.menu, -1, 1);
      this.focused = false;
      return;
    }
    if (p.file || p.viewer) {
      // The pane copy shows its own file; the viewer tab follows shared(VIEWER_KEY).
      this.mode = p.viewer ? "viewer" : "pane";
      this.doc = null;
      if (p.file) this.openDoc(p.file, p.on ?? null, cx);
      // Notices a deleted file, and a file that comes back.
      cx.timer.every(5000, cx => this.checkDoc(cx));
      return;
    }
    this.mode = "panel";
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set();
    this.marks = {}; this.treeMarks = { files: new Map(), folders: new Map() };
    this.reqNonce = shared(REQUEST_KEY)?.nonce ?? null;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  // ---- the one open document (viewer tab and pane copies) ----

  makeState(path, value) {
    const t = theme();
    return EditorState.new({ language: languageFor(path), readonly: true, value,
      font_family: settings().font_family, font_size: 12, soft_wrap: this.wrap,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi1, operator: t.muted, variable: t.foreground, punctuation: t.muted, "string.escape": t.ansi6 } });
  }

  // Releases the old editor first: only one file's text is ever held.
  openDoc(abs, on, cx) {
    this.doc?.state?.release();
    const doc = { abs, on, state: null, error: null, loading: true, truncated: false, lines: 0 };
    this.doc = doc;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(abs, { on });
        if (this.doc !== doc) return;
        if (text === null) doc.error = GONE;
        else if (text.includes("\0")) doc.error = "Binary file · no text preview";
        else {
          const preview = previewText(text);
          doc.state = this.makeState(abs, preview.value);
          doc.truncated = preview.truncated;
          doc.lines = lineCount(text);
        }
      } catch { if (this.doc === doc) doc.error = "Cannot preview this file (binary, too large, or unreadable)"; }
      doc.loading = false;
      cx.notify();
    });
  }

  reloadDoc(cx) {
    const doc = this.doc;
    if (doc?.diff) this.openDiff(doc.abs, doc.on, doc.diff, cx);
    else if (doc) this.openDoc(doc.abs, doc.on, cx);
    cx.notify();
  }

  async exists(abs, on) {
    if (!on && window()?.platform === "windows") return (await readTextFile(abs, { on })) !== null;
    return (await exec("sh", ["-c", 'test -e "$1"', "x", abs], { on })).code === 0;
  }

  checkDoc(cx) {
    const doc = this.doc;
    if (!doc || doc.loading) return;
    if (doc.diff) { this.loadDiff(doc, cx); return; }
    cx.spawn(async cx => {
      let here;
      try { here = await this.exists(doc.abs, doc.on); } catch { return; }
      if (this.doc !== doc) return;
      if (!here && doc.error !== GONE) {
        doc.state?.release(); doc.state = null; doc.error = GONE; doc.lines = 0;
        cx.notify();
      } else if (here && doc.error === GONE) this.openDoc(doc.abs, doc.on, cx);
    });
  }

  // The viewer tab follows shared(VIEWER_KEY); read during render, so load in a task.
  followViewer(cx) {
    const want = shared(VIEWER_KEY);
    if (!want?.abs || this.following === want.nonce) return;
    this.following = want.nonce;
    const same = this.doc && this.doc.abs === want.abs && this.doc.on === (want.on ?? null)
      && JSON.stringify(this.doc.diff ?? null) === JSON.stringify(want.diff ?? null);
    if (same) return;
    cx.spawn(async cx => {
      await cx.sleep(0);
      if (want.diff) this.openDiff(want.abs, want.on ?? null, want.diff, cx);
      else this.openDoc(want.abs, want.on ?? null, cx);
    });
  }

  // ---- diff mode: one changed file's git diff ----

  openDiff(abs, on, diff, cx) {
    this.doc?.state?.release();
    const doc = { abs, on, diff, rows: [], width: 300, error: null, loading: true, group: diff.group, text: null };
    this.doc = doc;
    this.loadDiff(doc, cx);
  }

  // Re-run quietly by the timer: the diff follows edits, staging and commits.
  loadDiff(doc, cx) {
    cx.spawn(async cx => {
      try {
        const { root, path, fresh } = doc.diff;
        let lines = null, group = doc.diff.group;
        if (fresh) {
          const text = await readTextFile(doc.abs, { on: doc.on });
          lines = text === null ? [GONE] : text.includes("\0") ? ["Binary file · no text diff"] : addedLines(text);
        } else {
          const run = (g) => exec("git", [...READ, ...diffArgs(g, path)], { cwd: root, on: doc.on });
          let r = await run(group);
          if (r.code !== 0) throw new Error(r.stderr);
          // Staged or unstaged since it was opened: show where the change is now.
          if (!r.stdout.includes("@@") && group !== "conflicts") {
            const other = group === "staged" ? "unstaged" : "staged";
            const r2 = await run(other);
            if (r2.code === 0 && r2.stdout.includes("@@")) { r = r2; group = other; }
          }
          lines = hunkLines(r.stdout, "No changes left in this file");
        }
        if (this.doc !== doc) return;
        const text = lines.join("\n");
        if (text === doc.text && group === doc.group) return;
        doc.text = text; doc.group = group;
        doc.rows = diffRows(lines); doc.width = diffWidth(doc.rows); doc.error = null;
      } catch (e) { if (this.doc === doc) doc.error = `Cannot show this diff: ${String(e?.message ?? e).split("\n")[0]}`; }
      finally { if (this.doc === doc) { doc.loading = false; cx.notify(); } }
    });
  }

  copyPath(abs, cx) {
    cx.write_to_clipboard(abs);
    const token = ++this.copyToken;
    this.copied = true;
    cx.timer.after(1200, cx => { if (this.copyToken === token) { this.copied = false; cx.notify(); } });
    cx.notify();
  }

  toggleWrap(cx) {
    this.wrap = !this.wrap;
    setShared("ranch.files.wrap", this.wrap);
    const doc = this.doc;
    if (doc?.state) {
      const value = doc.state.value();
      doc.state.release();
      doc.state = this.makeState(doc.abs, value);
    }
    cx.notify();
  }

  // ---- panel: tree ----

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map();
      this.folders = new Set(saved?.folders ?? []); this.pending = new Set();
      this.marks = {}; this.treeMarks = { files: new Map(), folders: new Map() };
      this.watched = null; this.error = null; this.limited = false; this.loading = false; this.gitTop = null;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.gitTop = top?.code === 0 ? top.stdout.trim() : null;
        this.marks = marks; this.treeMarks = treeMarks(marks, cwd);
        this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  collapseAll(cx) {
    for (const folder of this.folders) this.entries.delete(folder);
    this.folders.clear();
    cx.notify();
  }

  // The top bar opens (or reuses) the viewer tab for it.
  openFile(path, cx) {
    if (!this.root || !path) return;
    setShared(VIEWER_KEY, viewerRequest(`${this.root}/${path}`, this.on));
    cx.notify();
  }

  handleRequest(cx) {
    const req = shared(REQUEST_KEY);
    if (!req || req.nonce === undefined || req.nonce === this.reqNonce) return;
    if (req.ctx && req.ctx !== this.context?.key) return;
    this.reqNonce = req.nonce;
    const context = this.context;
    // Requests are read during render, where notify() throws; do the work in a task.
    cx.spawn(async cx => {
      await cx.sleep(0);
      if (this.context !== context || typeof req.path !== "string" || !req.path) return;
      if (req.action === "toggle") this.toggle(req.path, cx);
    });
  }

  // ---- menus ----

  revealItem(abs) {
    if (this.on) return null;
    const platform = window()?.platform;
    const icon = iconPath("folder-search");
    if (platform === "windows") return { label: "Reveal in File Explorer", icon, action: { type: "exec", cmd: "explorer", args: ["/select,", abs] } };
    if (platform === "linux") return { label: "Open containing folder", icon, action: { type: "exec", cmd: "xdg-open", args: [parentPath(abs)] } };
    return { label: "Reveal in Finder", icon, action: { type: "exec", cmd: "open", args: ["-R", abs] } };
  }

  fileMenu(path, name) {
    const abs = `${this.root}/${path}`;
    const items = [
      { label: "Open", icon: iconPath("folder-open"), action: { type: "request", key: VIEWER_KEY, value: { abs, on: this.on } } },
      { label: "Open in pane beside", icon: iconPath("panel-right"), action: { type: "run", name: "pane.split", args: { direction: "right", mod: "ranch-files", props: { file: abs, on: this.on } } } },
      { separator: true },
      { label: "Copy path", icon: iconPath("copy"), action: { type: "copy", text: abs } },
      { label: "Copy relative path", icon: iconPath("copy"), action: { type: "copy", text: path } },
      { label: "Copy name", icon: iconPath("copy"), action: { type: "copy", text: name } },
      { separator: true },
    ];
    const reveal = this.revealItem(abs);
    if (reveal) items.push(reveal);
    // terminal.open has no machine argument: a remote space's folder doesn't exist here.
    if (!this.on) items.push({ label: "Open terminal here", icon: iconPath("terminal"), action: { type: "run", name: "terminal.open", args: { folder: parentPath(abs), place: "right" } } });
    // The Changes panel keys files by the repo's top level, not the focused folder.
    const top = this.gitTop, inRepo = top && abs.startsWith(top + "/");
    if (inRepo && this.treeMarks.files.get(path)) items.push({ separator: true }, { label: "Show changes", icon: iconPath("git-compare"), action: { type: "many", actions: [
      { type: "request", key: "ranch.changes.select", value: { root: top, path: abs.slice(top.length + 1) } },
      { type: "run", name: "layout.select", args: { stack: "panel-body", child: "changes" } },
    ] } });
    return items;
  }

  folderMenu(path, open) {
    const abs = `${this.root}/${path}`, ctx = this.context.key;
    return [
      { label: open ? "Collapse" : "Expand", icon: iconPath("folder-open"), action: { type: "request", key: REQUEST_KEY, value: { action: "toggle", path, ctx } } },
      this.on ? null : { label: "Open terminal here", icon: iconPath("terminal"), action: { type: "run", name: "terminal.open", args: { folder: abs, place: "right" } } },
      { separator: true },
      { label: "Copy path", icon: iconPath("copy"), action: { type: "copy", text: abs } },
      { label: "Copy relative path", icon: iconPath("copy"), action: { type: "copy", text: path } },
      this.revealItem(abs),
    ].filter(Boolean);
  }

  openRowMenu(entry, path, cx) {
    cx.stop_propagation();
    openMenu({ openOverlay, mod: "ranch-files", items: entry.dir ? this.folderMenu(path, this.folders.has(path)) : this.fileMenu(path, entry.name) });
  }

  renderMenuMode() {
    if (!this.focused) { this.focused = true; this.handle.focus(); }
    const items = props().menu ?? [];
    return renderMenu({ items, active: this.active, theme, div, h_flex, v_flex, svg,
      onPick: (i, cx) => this.pick(i, cx),
      onHover: (i, cx) => { if (this.active !== i) { this.active = i; cx.notify(); } } })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const result = menuKey(e.key, items, this.active);
        if (result.close) { cx.stop_propagation(); closeOverlay(props().overlay); return; }
        if (result.pick !== undefined) { cx.stop_propagation(); this.pick(result.pick, cx); return; }
        if (result.active !== undefined) { cx.stop_propagation(); this.active = result.active; cx.notify(); }
      });
  }

  pick(index, cx) {
    const action = props().menu?.[index]?.action;
    cx.spawn(async cx => {
      try { await runAction(action, { run, setShared, exec, copy: text => cx.write_to_clipboard(text) }); } catch {}
      closeOverlay(props().overlay);
    });
  }

  // ---- rendering ----

  rows(prefix, depth, out, t, viewing) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.treeMarks.files.get(path);
      const icon = entry.dir ? folderIcon(entry.name, open) : fileIcon(entry.name);
      const folderMark = entry.dir ? this.treeMarks.folders.get(path) : null;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(!entry.dir && viewing === path, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.openFile(path, cx))
        .on_mouse_down("right", (_e, cx) => this.openRowMenu(entry, path, cx))
        .child(entry.dir ? svg(`mods/ranch-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(iconPath(icon.icon)).size(14).flex_none().text_color(t[icon.color] ?? t.muted))
        .child(div().flex_1().min_w(0).truncate().when(Boolean(mark), el => el.text_color(markColor(mark, t))).child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(markColor(mark, t)).child(mark)))
        .when(Boolean(folderMark), el => el.child(div().size(6).flex_none().rounded(3).bg(markColor(folderMark, t)))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, viewing);
    }
    return out;
  }

  iconButton(id, icon, onClick, active = false) {
    const t = theme();
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .when(active, el => el.bg(t.selected).text_color(t.foreground))
      .when(!active, el => el.text_color(t.muted))
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(iconPath(icon)).size(14));
  }

  // The viewer tab and the pane: crumbs with actions, the editor, a status line.
  renderDoc() {
    const t = theme(), doc = this.doc;
    if (!doc) return v_flex().id("files-doc").size_full().items_center().justify_center().bg(t.surface).text_size(12).text_color(t.dim)
      .child("Open a file from the Files panel");
    const parts = viewerBreadcrumbs(doc.abs, location().cwd && doc.abs.startsWith(location().cwd + "/") ? location().cwd : null);
    const status = `${languageFor(doc.abs)} · ${doc.lines} lines · read-only${doc.truncated ? " · truncated" : ""}`;
    return v_flex().id("files-doc").size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().id("files-crumbs").h(32).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border)
        .child(svg(iconPath(fileIcon(parts[parts.length - 1] ?? "").icon)).size(14).flex_none().mr(4).text_color(t[fileIcon(parts[parts.length - 1] ?? "").color] ?? t.muted))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(3).items_center()
          .children(parts.flatMap((part, i) => {
            const segment = div().min_w(0).truncate().text_size(12).text_color(i === parts.length - 1 ? t.foreground : t.dim).child(part);
            return i ? [div().flex_none().text_size(12).text_color(t.dim).child("/"), segment] : [segment];
          })))
        .when(this.copied, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("Copied")))
        .child(this.iconButton("files-wrap", "wrap-text", cx => this.toggleWrap(cx), this.wrap))
        .child(this.iconButton("files-copy", "copy", cx => this.copyPath(doc.abs, cx)))
        .child(this.iconButton("files-reload", "refresh-cw", cx => this.reloadDoc(cx))))
      .child(doc.state ? Editor.new(doc.state).flex_1().min_h(0)
        : div().flex_1().min_h(0).p(14).text_size(12).text_color(t.dim).child(doc.error ?? "Loading file…"))
      .child(h_flex().h(24).flex_none().px(12).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(status));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === " " ? "" : kind))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // Header (path, which side of the index, open file / reload), the diff, totals.
  renderDiff() {
    const t = theme(), doc = this.doc, rows = doc.rows;
    const parts = doc.diff.path.split("/");
    const { add, del } = diffStats(rows);
    const label = GROUP_LABEL[doc.group] ?? "Changes";
    return v_flex().id("files-diff").size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().id("diff-crumbs").h(32).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border)
        .child(svg(iconPath("git-compare")).size(14).flex_none().mr(4).text_color(t.blocked))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(3).items_center()
          .children(parts.flatMap((part, i) => {
            const segment = div().min_w(0).truncate().text_size(12).text_color(i === parts.length - 1 ? t.foreground : t.dim).child(part);
            return i ? [div().flex_none().text_size(12).text_color(t.dim).child("/"), segment] : [segment];
          }))
          .child(div().ml(6).flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(label)))
        .child(this.iconButton("diff-open-file", "file", () => setShared(VIEWER_KEY, viewerRequest(doc.abs, doc.on))))
        .child(this.iconButton("diff-reload", "refresh-cw", cx => this.reloadDoc(cx))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .when(rows.length > 0, e => e
          .child(div().id("diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(doc.width + 20).h_full().child(v_virtual_list("viewer-diff", rows.length, 20, (i) => String(i),
              (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
          .child(Scrollbar.vertical("viewer-diff").viewport_from_layout().absolute().inset_0()))
        .when(!rows.length, e => e.child(div().p(14).text_size(12).text_color(t.dim).child(doc.error ?? (doc.loading ? "Loading diff…" : "No changes")))))
      .child(h_flex().h(24).flex_none().px(12).gap(8).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().text_color(t.ansi2).child(`+${add}`))
        .child(div().text_color(t.ansi1).child(`−${del}`))
        .child(div().child(`· ${label.toLowerCase()} · ${languageFor(doc.abs)}`)));
  }

  renderBody(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    this.handleRequest(cx);
    const t = theme();
    const folder = this.root?.split(/[\\/]/).pop() ?? "";
    const want = shared(VIEWER_KEY)?.abs, viewing = this.root && want?.startsWith(this.root + "/") ? want.slice(this.root.length + 1) : null;
    return v_flex().id("files").size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1())
        .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(folder))
        .child(this.iconButton("files-collapse-all", "chevrons-down-up", cx => this.collapseAll(cx)))
        .child(this.iconButton("files-refresh", "refresh-cw", cx => this.refresh(cx))))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t, viewing))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }

  render(cx) {
    if (this.mode === "menu") return this.renderMenuMode();
    if (this.mode === "viewer") { this.followViewer(cx); return this.doc?.diff ? this.renderDiff() : this.renderDoc(); }
    if (this.mode === "pane") return this.renderDoc();
    // Left-edge drag strip on the panel column with a hover cue (lib/edge-grip.js).
    this.grip ??= new EdgeGrip({
      id: "panel", side: "left", min: 280, max: 640, div, theme, run,
      width: () => this.grip.measured ?? 360,
    });
    return this.grip.wrap(this.renderBody(cx), theme().surface);
  }
}
