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
