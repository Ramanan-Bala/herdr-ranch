// The smart tab namer runtime (requirements §8): observes Herdr's live data and
// the Ranch task store, renames tabs with `tab.rename` using the pure decision
// logic in ./lib/naming.js. Names flow ONE WAY (agent -> tab): this file never
// sends anything to an agent or terminal (no `hc send`, no `hc keys`).
import {
  spaces, agents, panes, shared, setShared, run, exec, readTextFile, home,
} from "herdr";
import {
  decide, exitAction, rememberSession, recallSession, ownership, cleanTitle,
} from "./lib/naming.js";
import { parseStore, storeFileName } from "./lib/tasks.js";
import {
  SETTINGS_KEY, AUTONAMES_KEY, SESSIONS_KEY, TASKS_DIR, resolveSettings,
} from "./lib/settings.js";
import { folderLabel } from "./lib/format.js";
import { agentShort, collectInputs, buildModelPrompt } from "./namer-model.js";

const STORE_TTL = 2000;
/** Shared state: { [tabId]: { state, at } } from Ranch's hooks (see lib/tasks.js). */
export const ACTIVITY_KEY = "ranch.activity";

/** A pane in `tabId` running an agent program, shaped like an agents() entry. */
function paneAgent(panesAll, tabId) {
  // The running program wins: a pane whose agent exited back to a shell keeps
  // a stale `app`, and must not be named "<shell> · <repo>".
  const p = panesAll.find((x) => x.tab === tabId && x.terminal && (x.program ? x.program.agent : x.app));
  return p ? { address: p.terminal, pane: p.pane, tab: tabId, app: p.app, program: p.program, status: p.status } : null;
}

export class TabNamer {
  constructor() {
    this.stores = new Map(); // agent address -> { store, at }
    this.homes = new Map(); // machine name -> home dir
    this.prev = new Map(); // tab id -> { agent, state, cwd, tasks } from last tick
    this.locked = new Map(); // tab id -> latest candidate while user-locked
    this.modelTitles = new Map(); // session id -> model summary
    this.modelTried = new Map(); // session id -> one attempt was made
    this.logged = new Set(); // distinct error messages already logged
  }

  // Herdr gives no rename-in-progress signal; kept as a decide() parameter.
  isEditing(_tabId) {
    return false;
  }

  /** Called once from the sidebar View's init(props, cx). */
  start(cx) {
    cx.timer.every(2000, (cx) => this.tick(cx));
    this.tick(cx);
  }

  /** One cheap, idempotent pass over all tabs; async work happens in a spawn. */
  tick(cx) {
    // A slow pass (remote exec) must not overlap the next tick.
    if (this.running) return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        await this.pass();
      } catch (err) {
        this.logOnce(err);
      } finally {
        this.running = false;
      }
    });
  }

  logOnce(err) {
    const msg = String(err?.message ?? err);
    if (this.logged.has(msg)) return;
    this.logged.add(msg);
    console.log(`ranch-sidebar namer: ${msg}`);
  }

  async pass() {
    const settings = resolveSettings(shared(SETTINGS_KEY));
    if (shared("layout") !== "ranch") return;
    const agentsNow = agents();
    const panesNow = panes();
    const seen = new Set();
    const activity = {};
    for (const space of spaces()) {
      for (const tab of space.tabs) {
        seen.add(tab.id);
        try {
          // Activity from Ranch's hooks, for tabs where Herdr shows no status.
          const agent = agentsNow.find((a) => a.tab === tab.id) ?? paneAgent(panesNow, tab.id);
          if (agent) {
            const store = await this.loadStore(agent.address, space.machine);
            const act = store?.session?.activity;
            if (act) activity[tab.id] = act;
          }
          if (settings.naming.enabled) await this.handleTab(space, tab, agentsNow, panesNow, settings);
        } catch (err) {
          this.logOnce(err);
        }
      }
    }
    if (JSON.stringify(activity) !== JSON.stringify(shared(ACTIVITY_KEY) ?? {})) setShared(ACTIVITY_KEY, activity);
    for (const id of this.prev.keys()) {
      if (!seen.has(id)) {
        this.prev.delete(id);
        this.locked.delete(id);
      }
    }
  }

  async handleTab(space, tab, agentsAll, panesAll, settings) {
    const naming = settings.naming;
    // An agent whose status report was cleared (Herdr shows status null) is
    // still an agent session: fall back to a pane running a known agent app.
    const agent = agentsAll.find((a) => a.tab === tab.id) ?? paneAgent(panesAll, tab.id);
    const prev = this.prev.get(tab.id) ?? {};

    let store = null;
    let pane = null;
    if (agent) {
      pane = panesAll.find((p) => p.pane === agent.pane) ?? null;
      store = await this.loadStore(agent.address, space.machine);
    }
    const state = store?.session?.state ?? null;

    // Session exit (R-TN-3): the agent left the tab, or its session ended.
    if ((prev.agent && !agent) || (prev.state === "running" && state === "ended")) {
      await this.onExit(space, tab, prev, naming);
      this.prev.set(tab.id, { agent: null, state: null, cwd: null, tasks: 0 });
      return;
    }

    // Only agent sessions name tabs; a plain terminal keeps Herdr's own name.
    if (!agent) {
      this.prev.set(tab.id, { agent: null, state: null, cwd: null, tasks: 0 });
      return;
    }

    const record = shared(AUTONAMES_KEY)?.[tab.id];
    const own = ownership(tab, record);

    let candidate = collectInputs({
      agentTitle: store?.session?.title ?? null,
      agentTitleSource: store?.session?.title_source ?? null,
      terminalTitle: pane?.title ?? null,
      firstPrompt: store?.session?.first_prompt ?? null,
      branch: pane?.branch ?? null,
      agentName: agent ? agentShort(agent.program.name) : null,
      repo: folderLabel(pane?.cwd ?? null, home()),
      settings,
    });

    // Optional model summary (R-TN-6): once per session, one attempt at most.
    if (naming.model && candidate?.source === "prompt" && store?.session?.id && store.session.first_prompt) {
      candidate = await this.modelTitle(store.session, candidate);
    }

    // Resume: a known session id on an unnamed tab restores its last name.
    if (own === "unnamed" && store?.session?.id && !record) {
      const recalled = recallSession(shared(SESSIONS_KEY) ?? {}, store.session.id);
      if (recalled) candidate = { name: recalled, source: "agent_auto" };
    }

    const result = decide({
      tab,
      record,
      candidate,
      now: Date.now(),
      editing: this.isEditing(tab.id),
      siblingNames: space.tabs.filter((t) => t.id !== tab.id).map((t) => t.name),
      branch: pane?.branch ?? null,
    });

    if (result.action === "rename") {
      this.applyRename(space, tab, result, store?.session?.id ?? null);
    } else if (own === "locked" && candidate) {
      // Reset name -> unnamed -> next tick picks the current AI name at once.
      this.locked.set(tab.id, candidate);
    }

    this.prev.set(tab.id, {
      agent: agent?.address ?? null,
      state,
      cwd: pane?.cwd ?? null,
      tasks: store?.tasks.length ?? 0,
    });
  }

  async onExit(space, tab, prev, naming) {
    const record = shared(AUTONAMES_KEY)?.[tab.id];
    const own = ownership(tab, record);
    let dirty = false;
    if (!prev.tasks && prev.cwd) {
      try {
        const r = await exec("git", ["status", "--porcelain"], { cwd: prev.cwd, on: space.machine });
        dirty = r.code === 0 && r.stdout.trim() !== "";
      } catch (err) {
        this.logOnce(err);
      }
    }
    const action = exitAction({
      didWork: prev.tasks > 0 || dirty,
      mode: naming.exitMode,
      ownershipState: own,
      currentName: tab.name,
    });
    if (action.action === "reset") {
      const fresh = this.confirmName(space, tab);
      if (!fresh) return;
      run("tab.rename", { id: tab.id, name: "" });
      const current = shared(AUTONAMES_KEY) ?? {};
      if (tab.id in current) {
        const { [tab.id]: _gone, ...rest } = current;
        setShared(AUTONAMES_KEY, rest);
      }
    } else if (action.action === "rename") {
      // A record from before a title became generic (e.g. a bare "t11"
      // terminal address) must not be restored: drop it and stay unnamed.
      if (!cleanTitle(action.name)) {
        const current = shared(AUTONAMES_KEY) ?? {};
        if (tab.id in current) {
          const { [tab.id]: _gone, ...rest } = current;
          setShared(AUTONAMES_KEY, rest);
        }
        return;
      }
      this.applyRename(space, tab, { name: action.name, source: record?.source ?? "agent_auto" }, null);
    }
  }

  applyRename(space, tab, result, sessionId) {
    // Another Herdr client may run Ranch: only rename when the tab still has
    // the name this decision was based on.
    if (!this.confirmName(space, tab)) return;
    run("tab.rename", { id: tab.id, name: result.name });
    setShared(AUTONAMES_KEY, {
      ...(shared(AUTONAMES_KEY) ?? {}),
      [tab.id]: { name: result.name, source: result.source, at: Date.now() },
    });
    if (sessionId) {
      setShared(SESSIONS_KEY, rememberSession(shared(SESSIONS_KEY) ?? {}, sessionId, result.name));
    }
  }

  // Fresh spaces() read: true when the tab still exists with the same name.
  confirmName(space, tab) {
    const fresh = spaces().find((s) => s.id === space.id)?.tabs.find((t) => t.id === tab.id);
    return !!fresh && fresh.name === tab.name;
  }

  async modelTitle(session, candidate) {
    const sid = session.id;
    if (!this.modelTried.has(sid)) {
      this.modelTried.set(sid, true);
      try {
        const r = await exec("claude", ["-p", "--model", "haiku", buildModelPrompt(session.first_prompt)], {
          timeout: 5000,
        });
        const out = r.stdout.trim();
        if (r.code === 0 && out && !out.includes("\n")) {
          const cleaned = cleanTitle(out);
          if (cleaned) this.modelTitles.set(sid, cleaned);
        }
      } catch (err) {
        this.logOnce(err);
      }
    }
    const title = this.modelTitles.get(sid);
    return title ? { name: title, source: candidate.source } : candidate;
  }

  /** Render-time access: the last loaded store for an agent, no I/O. */
  cachedStore(address) {
    return this.stores.get(address)?.store ?? null;
  }

  async loadStore(address, machine) {
    const file = storeFileName(address);
    if (!file) return null;
    const cached = this.stores.get(address);
    if (cached && Date.now() - cached.at < STORE_TTL) return cached.store;
    let store = null;
    try {
      const dir = await this.homeFor(machine);
      if (dir) {
        const text = await readTextFile(`${dir}/${TASKS_DIR}/${file}`, { on: machine });
        const parsed = parseStore(text);
        if (parsed.ok) store = parsed.store;
      }
    } catch (err) {
      this.logOnce(err);
    }
    this.stores.set(address, { store, at: Date.now() });
    return store;
  }

  async homeFor(machine) {
    if (!machine) return home();
    const cached = this.homes.get(machine);
    if (cached) return cached;
    try {
      const r = await exec("sh", ["-c", "printf %s \"$HOME\""], { on: machine });
      const dir = r.stdout.trim();
      if (dir) {
        this.homes.set(machine, dir);
        return dir;
      }
    } catch (err) {
      this.logOnce(err);
    }
    return null;
  }
}
