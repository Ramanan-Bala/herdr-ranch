// System stats for the bottom status bar's resource strip: which processes belong
// to Herdr sessions and what they use. Pure module (no herdr/gpui imports) so it
// can be copied into every mod and tested in Node.

/** The last segment of a command path, e.g. "/a/b/herdr-core" -> "herdr-core". */
function baseName(comm) {
  if (typeof comm !== "string") return "";
  const s = comm.replace(/[/\\]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Parses `ps -axo pid=,ppid=,rss=,pcpu=,comm=` output. `comm` is the rest of the
 *  line (it may contain spaces). Malformed lines are skipped. */
export function parsePs(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rss = Number(parts[2]);
    const cpu = Number(parts[3]);
    if (![pid, ppid, rss, cpu].every(Number.isFinite)) continue;
    out.push({ pid, ppid, rss, cpu, comm: parts.slice(4).join(" ") });
  }
  return out;
}

/** Pids that descend from a herdr-core root. The roots themselves and any
 *  herdr-core descendant are excluded. Cycle-safe. */
export function sessionPids(procs) {
  const list = Array.isArray(procs) ? procs : [];
  const isRoot = (p) => baseName(p.comm) === "herdr-core";
  const children = new Map();
  for (const p of list) {
    const kids = children.get(p.ppid);
    if (kids) kids.push(p);
    else children.set(p.ppid, [p]);
  }
  const out = new Set();
  const seen = new Set();
  const stack = [];
  for (const p of list) {
    if (!isRoot(p) || seen.has(p.pid)) continue;
    seen.add(p.pid);
    for (const c of children.get(p.pid) ?? []) stack.push(c);
  }
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    for (const c of children.get(p.pid) ?? []) stack.push(c);
    if (!isRoot(p)) out.add(p.pid);
  }
  return out;
}

/** Sums rss (KB) and cpu over the procs whose pid is in `pids`. */
export function sumUsage(procs, pids) {
  const set = pids instanceof Set ? pids : new Set(pids ?? []);
  let rssKB = 0;
  let cpu = 0;
  let count = 0;
  for (const p of Array.isArray(procs) ? procs : []) {
    if (!set.has(p.pid)) continue;
    rssKB += Number(p.rss) || 0;
    cpu += Number(p.cpu) || 0;
    count++;
  }
  return { rssKB, cpu, count };
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn` field output into
 *  {pid, command, port} entries, one per distinct pid+port. */
export function parseLsofListen(text) {
  const out = [];
  const seen = new Set();
  let pid = null;
  let command = "";
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    if (line[0] === "p") {
      pid = Number(line.slice(1));
      command = "";
    } else if (line[0] === "c") {
      command = line.slice(1);
    } else if (line[0] === "n") {
      const addr = line.slice(1);
      const port = Number(addr.slice(addr.lastIndexOf(":") + 1));
      if (!Number.isFinite(pid) || !Number.isFinite(port)) continue;
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, command, port });
    }
  }
  return out;
}

/** Entries whose pid is in `pids`, deduped by port, sorted by port ascending. */
export function sessionPorts(listens, pids) {
  const set = pids instanceof Set ? pids : new Set(pids ?? []);
  const byPort = new Map();
  for (const e of Array.isArray(listens) ? listens : []) {
    if (!set.has(e.pid) || byPort.has(e.port)) continue;
    byPort.set(e.port, e);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** "900 MB" below 1024 MB, else "1.5 GB"; 0 or invalid -> "0 MB". */
export function formatMemory(kb) {
  const n = Number(kb);
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  const mb = n / 1024;
  const rounded = Math.round(mb);
  return rounded < 1024 ? `${rounded} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

/** Converts a Set or Array to a Set, returning an empty Set for other inputs. */
function toSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

/** Returns value if it is a positive integer, else null. */
function positiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Indexes known tabs in spaces by tab id -> { tabId, tabName, spaceId, spaceName }. */
function indexSpaceTabs(spaces) {
  const byTab = new Map();
  for (const sp of Array.isArray(spaces) ? spaces : []) {
    if (!sp || typeof sp !== "object") continue;
    const spaceId = typeof sp.id === "string" && sp.id ? sp.id : null;
    if (!spaceId) continue;
    const spaceName = typeof sp.name === "string" && sp.name ? sp.name : null;
    if (!Array.isArray(sp.tabs)) continue;
    for (const tb of sp.tabs) {
      if (!tb || typeof tb !== "object") continue;
      if (typeof tb.id !== "string" || !tb.id) continue;
      const tabName = typeof tb.name === "string" && tb.name ? tb.name : null;
      byTab.set(tb.id, { tabId: tb.id, tabName, spaceId, spaceName });
    }
  }
  return byTab;
}

/** Parses `hc get --json <address>` output into { address, pid, tab, space, title, cwd, createdMs, foreground }, or null. */
export function parseHcGet(text) {
  if (typeof text !== "string") return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (typeof data.address !== "string" || data.address.trim() === "") return null;
  if (typeof data.pid !== "number" || !Number.isInteger(data.pid) || data.pid <= 0) return null;
  const labels = data.labels && typeof data.labels === "object" && !Array.isArray(data.labels) ? data.labels : null;
  const tab = labels && typeof labels["herdr.tab"] === "string" && labels["herdr.tab"] ? labels["herdr.tab"] : null;
  const space = labels && typeof labels["herdr.space"] === "string" && labels["herdr.space"] ? labels["herdr.space"] : null;
  const title = typeof data.title === "string" ? data.title : null;
  const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : null;
  const createdMs =
    typeof data.created_ms === "number" && Number.isFinite(data.created_ms) && data.created_ms > 0
      ? data.created_ms
      : null;
  const fgRaw =
    data.foreground && typeof data.foreground === "object" && !Array.isArray(data.foreground)
      ? data.foreground
      : null;
  const foreground = fgRaw
    ? {
        name: typeof fgRaw.name === "string" && fgRaw.name ? fgRaw.name : null,
        pid: positiveInt(fgRaw.pid),
      }
    : null;
  return { address: data.address, pid: data.pid, tab, space, title, cwd, createdMs, foreground };
}

/** Attributes in-session processes to terminals in input order, plus an unclaimed `other` bucket. */
export function attributeTerminals(procs, terminals) {
  const list = Array.isArray(procs) ? procs.filter((p) => p && typeof p === "object") : [];
  const terms = Array.isArray(terminals) ? terminals : [];
  const inSession = sessionPids(list);
  const children = new Map();
  for (const p of list) {
    const kids = children.get(p.ppid);
    if (kids) kids.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }

  const claimed = new Set();
  const out = [];
  for (const raw of terms) {
    const t = raw && typeof raw === "object" ? raw : {};
    const validPid = typeof t.pid === "number" && Number.isInteger(t.pid) && t.pid > 0;
    const alive = validPid && inSession.has(t.pid);
    const own = new Set();
    if (alive) {
      const stack = [t.pid];
      while (stack.length) {
        const pid = stack.pop();
        if (!inSession.has(pid) || claimed.has(pid)) continue;
        claimed.add(pid);
        own.add(pid);
        for (const childPid of children.get(pid) ?? []) stack.push(childPid);
      }
    }
    const usage = alive ? sumUsage(list, own) : { rssKB: 0, cpu: 0, count: 0 };
    out.push({
      address: t.address ?? null,
      tab: t.tab ?? null,
      space: t.space ?? null,
      title: t.title ?? null,
      pid: validPid ? t.pid : null,
      alive,
      rssKB: usage.rssKB,
      cpu: usage.cpu,
      count: usage.count,
    });
  }

  const unclaimed = new Set();
  for (const pid of inSession) {
    if (!claimed.has(pid)) unclaimed.add(pid);
  }
  return { terminals: out, other: sumUsage(list, unclaimed) };
}

/** Maximum number of samples kept per key in a history ring store. */
export const HISTORY_CAPACITY = 60;

/** Appends a finite sample (else 0) to key's ring in store, trimming to HISTORY_CAPACITY. */
export function pushHistory(store, key, value, now) {
  if (!(store instanceof Map) || key == null) return;
  const sample = Number.isFinite(value) ? value : 0;
  const touchedAt = Number.isFinite(now) ? now : 0;
  let entry = store.get(key);
  if (!entry || !Array.isArray(entry.samples)) {
    entry = { samples: [], touchedAt };
    store.set(key, entry);
  }
  entry.samples.push(sample);
  if (entry.samples.length > HISTORY_CAPACITY) {
    entry.samples.splice(0, entry.samples.length - HISTORY_CAPACITY);
  }
  entry.touchedAt = touchedAt;
}

/** Returns a copy of key's samples (oldest first), or []. */
export function readHistory(store, key) {
  if (!(store instanceof Map) || key == null) return [];
  const entry = store.get(key);
  return entry && Array.isArray(entry.samples) ? entry.samples.slice() : [];
}

/** Removes keys from store whose touchedAt is older than now - staleMs. */
export function sweepHistory(store, now, staleMs = 600000) {
  if (!(store instanceof Map) || !Number.isFinite(now)) return;
  const maxAge = Number.isFinite(staleMs) ? staleMs : 600000;
  const cutoff = now - maxAge;
  for (const [key, entry] of store) {
    if (entry && Number.isFinite(entry.touchedAt) && entry.touchedAt < cutoff) {
      store.delete(key);
    }
  }
}

/** Parses macOS `memory_pressure -Q` free percentage into available bytes, or null. */
export function parseMemoryPressure(text, totalBytes) {
  if (typeof text !== "string" || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const m = /System-wide memory free percentage:\s*([+-]?\d+(?:\.\d+)?)%/.exec(text);
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return Math.round((totalBytes * pct) / 100);
}

/** Parses Linux /proc/meminfo MemTotal and MemAvailable (kB) into bytes, or null. */
export function parseMeminfo(text) {
  if (typeof text !== "string") return null;
  let total = null;
  let available = null;
  for (const line of text.split("\n")) {
    const m = /^\s*(MemTotal|MemAvailable):\s*(\d+)\s+kB\s*$/.exec(line);
    if (!m) continue;
    const bytes = Number(m[2]) * 1024;
    if (!Number.isFinite(bytes)) continue;
    if (m[1] === "MemTotal") total = bytes;
    else if (m[1] === "MemAvailable") available = bytes;
  }
  if (total === null || available === null) return null;
  return { total, available };
}

/** Parses the 1-minute load average from macOS sysctl or Linux /proc/loadavg, or null. */
export function parseLoadAvg(text) {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (!s) return null;
  const m =
    /^\{\s*(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s*\}$/.exec(s) ??
    /^(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?(?:\s|$)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Computes clamped host memory totals, usage, and percentage from byte counts. */
export function hostMemory(totalBytes, availableBytes) {
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const rawAvail = Number.isFinite(availableBytes) ? availableBytes : 0;
  const available = Math.min(total, Math.max(0, rawAvail));
  const used = total - available;
  const percent = total > 0 ? (used / total) * 100 : 0;
  return { total, available, used, percent };
}

/** Returns a new rows array sorted by "memory", "cpu", or "name" (tie/unknown -> name asc). */
export function sortRows(rows, by) {
  if (!Array.isArray(rows)) return [];
  const num = (r, k) => (r && typeof r === "object" && Number.isFinite(r[k]) ? r[k] : 0);
  const nameOf = (r) => (r && typeof r === "object" && typeof r.name === "string" ? r.name : "");
  return rows.slice().sort((a, b) => {
    if (by === "memory") {
      const d = num(b, "rssKB") - num(a, "rssKB");
      if (d !== 0) return d;
    } else if (by === "cpu") {
      const d = num(b, "cpu") - num(a, "cpu");
      if (d !== 0) return d;
    }
    return nameOf(a).localeCompare(nameOf(b));
  });
}

/** Deprecated: use buildResourceTree. Groups alive terminal rows by space, attaches history samples, and sorts rows and groups. */
export function buildResourceGroups({ rows, spaces, history, sort } = {}) {
  const rowList = Array.isArray(rows) ? rows : [];
  const spaceList = Array.isArray(spaces) ? spaces : [];
  const spaceNames = new Map();
  const tabNames = new Map();
  for (const sp of spaceList) {
    if (!sp || typeof sp !== "object") continue;
    if (typeof sp.id === "string" && sp.id) {
      spaceNames.set(sp.id, typeof sp.name === "string" && sp.name ? sp.name : "Other");
    }
    if (Array.isArray(sp.tabs)) {
      for (const tb of sp.tabs) {
        if (!tb || typeof tb !== "object") continue;
        if (typeof tb.id === "string" && tb.id && typeof tb.name === "string" && tb.name) {
          tabNames.set(tb.id, tb.name);
        }
      }
    }
  }

  const bySpace = new Map();
  for (const r of rowList) {
    if (!r || typeof r !== "object" || !r.alive) continue;
    const knownSpace = typeof r.space === "string" && spaceNames.has(r.space);
    const groupId = knownSpace ? r.space : null;
    const groupName = knownSpace ? spaceNames.get(r.space) : "Other";
    const tabName = typeof r.tab === "string" && tabNames.has(r.tab) ? tabNames.get(r.tab) : null;
    const title = typeof r.title === "string" && r.title ? r.title : null;
    const label = [tabName, title].filter(Boolean).join(" · ");
    const rssKB = Number.isFinite(r.rssKB) ? r.rssKB : 0;
    const cpu = Number.isFinite(r.cpu) ? r.cpu : 0;
    const item = {
      address: r.address ?? null,
      tab: r.tab ?? null,
      label,
      rssKB,
      cpu,
      alive: true,
      history: readHistory(history, r.address),
      name: label,
    };
    let group = bySpace.get(groupId);
    if (!group) {
      group = { id: groupId, name: groupName, rssKB: 0, cpu: 0, rows: [] };
      bySpace.set(groupId, group);
    }
    group.rssKB += rssKB;
    group.cpu += cpu;
    group.rows.push(item);
  }

  const groups = [];
  for (const group of bySpace.values()) {
    const sorted = sortRows(group.rows, sort).map(({ name: _name, ...row }) => row);
    groups.push({ id: group.id, name: group.name, rssKB: group.rssKB, cpu: group.cpu, rows: sorted });
  }
  return sortRows(groups, sort);
}

/** Summarizes Herdr app and herdr-core RSS, CPU, and process counts from parsed ps rows. */
export function herdrUsage(procs) {
  const app = { rssKB: 0, cpu: 0, count: 0 };
  const core = { rssKB: 0, cpu: 0, count: 0 };
  for (const p of Array.isArray(procs) ? procs : []) {
    if (!p || typeof p !== "object") continue;
    const comm = typeof p.comm === "string" ? p.comm : "";
    const base = baseName(comm);
    let bucket = null;
    if (base === "herdr-core") {
      bucket = core;
    } else if (comm.includes("/Herdr.app/") || base === "Herdr" || base === "herdr-app") {
      bucket = app;
    }
    if (!bucket) continue;
    const rss = Number(p.rss);
    const cpu = Number(p.cpu);
    bucket.rssKB += Number.isFinite(rss) ? rss : 0;
    bucket.cpu += Number.isFinite(cpu) ? cpu : 0;
    bucket.count++;
  }
  return {
    app,
    core,
    rssKB: app.rssKB + core.rssKB,
    cpu: app.cpu + core.cpu,
    count: app.count + core.count,
  };
}

/** Splits RSS (KB) across Herdr itself, alive agent terminals, and other alive terminals. */
export function ownerSplit(input) {
  const { herdr, rows, agentAddresses } = input && typeof input === "object" ? input : {};
  const agentsSet = toSet(agentAddresses);
  const herdrRss = herdr && typeof herdr === "object" && Number.isFinite(herdr.rssKB) ? herdr.rssKB : 0;
  let agents = 0;
  let other = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object" || !r.alive) continue;
    const rss = Number.isFinite(r.rssKB) ? r.rssKB : 0;
    if (r.address != null && agentsSet.has(r.address)) agents += rss;
    else other += rss;
  }
  return { herdr: herdrRss, agents, other };
}

/** Returns true when a terminal has no known tab and no live listed parent terminal. */
export function isOrphan(term, listedAddresses, knownTabIds) {
  if (!term || typeof term !== "object") return false;
  const tabs = toSet(knownTabIds);
  const labels = term.labels && typeof term.labels === "object" && !Array.isArray(term.labels) ? term.labels : null;
  const tab =
    (labels && typeof labels["herdr.tab"] === "string" && labels["herdr.tab"]) ||
    (typeof term.tab === "string" && term.tab) ||
    null;
  if (tab && tabs.has(tab)) return false;
  const listed = toSet(listedAddresses);
  const parent = typeof term.parent === "string" && term.parent ? term.parent : null;
  if (parent && listed.has(parent)) return false;
  return true;
}

/** Builds a sorted space -> tab -> terminal resource tree with history, Background group, and orphans. */
export function buildResourceTree(input) {
  const { rows, spaces, history, sort, agentAddresses, orphanAddresses } =
    input && typeof input === "object" ? input : {};
  const rowList = Array.isArray(rows) ? rows : [];
  const tabLookup = indexSpaceTabs(spaces);
  const agentSet = toSet(agentAddresses);
  const orphanSet = toSet(orphanAddresses);

  const bySpace = new Map();
  const bgTerminals = [];
  const orphanNodes = [];

  for (const r of rowList) {
    if (!r || typeof r !== "object" || !r.alive) continue;
    const address = typeof r.address === "string" && r.address ? r.address : null;
    const tab = typeof r.tab === "string" && r.tab ? r.tab : null;
    const title = typeof r.title === "string" && r.title ? r.title : null;
    const label = title ?? address ?? "";
    const rssKB = Number.isFinite(r.rssKB) ? r.rssKB : 0;
    const cpu = Number.isFinite(r.cpu) ? r.cpu : 0;
    const tabInfo = tab ? tabLookup.get(tab) ?? null : null;
    const bound = Boolean(tabInfo);
    const agent = Boolean(address && agentSet.has(address));

    const node = {
      address: r.address ?? null,
      tab: r.tab ?? null,
      space: r.space ?? null,
      label,
      rssKB,
      cpu,
      history: readHistory(history, r.address),
      bound,
      agent,
      name: label,
    };

    if (bound) {
      let sp = bySpace.get(tabInfo.spaceId);
      if (!sp) {
        sp = {
          id: tabInfo.spaceId,
          name: tabInfo.spaceName ?? tabInfo.spaceId,
          tabsById: new Map(),
        };
        bySpace.set(tabInfo.spaceId, sp);
      }
      let tb = sp.tabsById.get(tabInfo.tabId);
      if (!tb) {
        tb = {
          id: tabInfo.tabId,
          name: tabInfo.tabName ?? tabInfo.tabId,
          rssKB: 0,
          cpu: 0,
          terminals: [],
        };
        sp.tabsById.set(tabInfo.tabId, tb);
      }
      tb.rssKB += rssKB;
      tb.cpu += cpu;
      tb.terminals.push(node);
    } else if (address && orphanSet.has(address)) {
      orphanNodes.push(node);
    } else {
      bgTerminals.push(node);
    }
  }

  const stripName = ({ name: _name, ...rest }) => rest;
  const spaceNodes = [];

  for (const sp of bySpace.values()) {
    const tabNodes = [];
    let rssKB = 0;
    let cpu = 0;
    for (const tb of sp.tabsById.values()) {
      rssKB += tb.rssKB;
      cpu += tb.cpu;
      tabNodes.push({
        id: tb.id,
        name: tb.name,
        rssKB: tb.rssKB,
        cpu: tb.cpu,
        history: readHistory(history, `tab:${tb.id}`),
        terminals: sortRows(tb.terminals, sort).map(stripName),
      });
    }
    spaceNodes.push({
      id: sp.id,
      name: sp.name,
      rssKB,
      cpu,
      history: readHistory(history, `space:${sp.id}`),
      tabs: sortRows(tabNodes, sort),
    });
  }

  if (bgTerminals.length > 0) {
    let rssKB = 0;
    let cpu = 0;
    for (const t of bgTerminals) {
      rssKB += t.rssKB;
      cpu += t.cpu;
    }
    const bgTab = {
      id: null,
      name: "Background",
      rssKB,
      cpu,
      history: readHistory(history, "tab:background"),
      terminals: sortRows(bgTerminals, sort).map(stripName),
    };
    spaceNodes.push({
      id: null,
      name: "Background",
      rssKB,
      cpu,
      history: readHistory(history, "space:background"),
      tabs: [bgTab],
    });
  }

  return {
    spaces: sortRows(spaceNodes, sort),
    orphans: sortRows(orphanNodes, sort).map(stripName),
  };
}

/** Extracts [historyKey, bytes] pairs for all spaces, tabs, terminals, and orphans in a resource tree. */
export function historySamples(tree) {
  if (!tree || typeof tree !== "object") return [];
  const toBytes = (kb) => (Number.isFinite(kb) ? kb : 0) * 1024;
  const out = [];
  for (const sp of Array.isArray(tree.spaces) ? tree.spaces : []) {
    if (!sp || typeof sp !== "object") continue;
    const spaceKey = typeof sp.id === "string" && sp.id ? `space:${sp.id}` : "space:background";
    out.push([spaceKey, toBytes(sp.rssKB)]);
    for (const tb of Array.isArray(sp.tabs) ? sp.tabs : []) {
      if (!tb || typeof tb !== "object") continue;
      const tabKey = typeof tb.id === "string" && tb.id ? `tab:${tb.id}` : "tab:background";
      out.push([tabKey, toBytes(tb.rssKB)]);
      for (const tm of Array.isArray(tb.terminals) ? tb.terminals : []) {
        if (!tm || typeof tm !== "object") continue;
        if (typeof tm.address === "string" && tm.address) {
          out.push([tm.address, toBytes(tm.rssKB)]);
        }
      }
    }
  }
  for (const tm of Array.isArray(tree.orphans) ? tree.orphans : []) {
    if (!tm || typeof tm !== "object") continue;
    if (typeof tm.address === "string" && tm.address) {
      out.push([tm.address, toBytes(tm.rssKB)]);
    }
  }
  return out;
}

/** Combines live terminals, hc get details, resource rows, and spaces into a Terminals tab inventory. */
export function buildTerminalInventory(input) {
  const { terminals, details, rows, spaces, orphanAddresses } =
    input && typeof input === "object" ? input : {};
  const termList = Array.isArray(terminals) ? terminals : [];
  const detailMap = details instanceof Map ? details : null;
  const tabLookup = indexSpaceTabs(spaces);
  const orphanSet = toSet(orphanAddresses);
  const rowByAddr = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.address === "string" && r.address && !rowByAddr.has(r.address)) {
      rowByAddr.set(r.address, r);
    }
  }

  const items = [];
  let withoutTab = 0;
  for (const raw of termList) {
    if (!raw || typeof raw !== "object") continue;
    const address = typeof raw.address === "string" && raw.address ? raw.address : null;
    const rawDetail = address && detailMap ? detailMap.get(address) : null;
    const detail = rawDetail && typeof rawDetail === "object" ? rawDetail : null;
    const row = address ? rowByAddr.get(address) ?? null : null;

    const labels = raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels) ? raw.labels : null;
    const tabId =
      (labels && typeof labels["herdr.tab"] === "string" && labels["herdr.tab"]) ||
      (typeof raw.tab === "string" && raw.tab) ||
      (detail && typeof detail.tab === "string" && detail.tab) ||
      null;
    const tabInfo = tabId ? tabLookup.get(tabId) ?? null : null;
    const bound = Boolean(tabInfo);
    if (!bound) withoutTab++;

    const title =
      (typeof raw.title === "string" && raw.title) ||
      (detail && typeof detail.title === "string" && detail.title) ||
      null;
    const pid = positiveInt(detail?.pid) ?? positiveInt(row?.pid) ?? positiveInt(raw.pid);
    const cwd =
      (typeof raw.cwd === "string" && raw.cwd) ||
      (detail && typeof detail.cwd === "string" && detail.cwd) ||
      null;
    const agent = typeof raw.agent === "string" && raw.agent ? raw.agent : null;
    const status = typeof raw.status === "string" && raw.status ? raw.status : null;
    const fg = detail && detail.foreground && typeof detail.foreground === "object" ? detail.foreground : null;
    const foreground = fg && typeof fg.name === "string" && fg.name ? fg.name : null;
    const foregroundPid = fg ? positiveInt(fg.pid) : null;
    const createdMs =
      detail && typeof detail.createdMs === "number" && Number.isFinite(detail.createdMs) && detail.createdMs > 0
        ? detail.createdMs
        : null;
    const orphan = Boolean(address && orphanSet.has(address));
    const alive = Boolean(row && row.alive);
    const rssKB = row && Number.isFinite(row.rssKB) ? row.rssKB : 0;
    const cpu = row && Number.isFinite(row.cpu) ? row.cpu : 0;
    const parent = typeof raw.parent === "string" && raw.parent ? raw.parent : null;

    items.push({
      address,
      title,
      pid,
      cwd,
      tabId,
      tabName: tabInfo ? tabInfo.tabName : null,
      spaceName: tabInfo ? tabInfo.spaceName : null,
      agent,
      status,
      foreground,
      foregroundPid,
      createdMs,
      bound,
      orphan,
      alive,
      rssKB,
      cpu,
      parent,
    });
  }

  return { count: items.length, withoutTab, items };
}
