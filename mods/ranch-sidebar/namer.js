// The smart tab namer runtime (requirements §8): observes Herdr's live data and
// the Ranch task store, renames tabs with `tab.rename` using the pure decision
// logic in ./lib/naming.js. Names flow ONE WAY (agent -> tab): this file never
// sends anything to an agent or terminal (no `hc send`, no `hc keys`).
import {
  spaces, agents, panes, terminals, shared, setShared, run, exec, readTextFile, home, watchFolder,
} from "herdr";
import {
  decide, exitAction, rememberSession, recallSession, ownership, cleanTitle, sessionChanged, withRecordSession, SOURCE_RANK,
} from "./lib/naming.js";
import { listVisible, parseStore, storeAddress, storeCandidates, withPointerIdentity } from "./lib/tasks.js";
import {
  SETTINGS_KEY, AUTONAMES_KEY, SESSIONS_KEY, TASKS_DIR, resolveSettings,
} from "./lib/settings.js";
import { folderLabel, subagentsWorking } from "./lib/format.js";
import { homeCache } from "./lib/home.js";
import { agentShort, collectInputs, buildModelPrompt, pickNamingAgent } from "./namer-model.js";

/** Store re-read cadence without a working folder watch (every tick). */
const STORE_TTL = 2000;
/** This computer, with the tasks folder watched: a store is re-read when the
 * watch fires, and at least this often in case an event was missed. */
const LOCAL_WATCHED_TTL = 30000;
/** Another machine (each read can be a remote call): the Session panel's
 * remote task cadence. */
const REMOTE_STORE_TTL = 5000;
/** How long a pass may run before the next tick replaces it. A Herdr read
 * that never settles (seen across a mod reload) once froze naming and the
 * sidebar's activity for good, because every later tick saw `running`. */
export const PASS_STALL_MS = 15000;
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
    this.stores = new Map(); // agent address -> { store, at, gen }
    // Local tasks folder watch: every change bumps localGen, which invalidates
    // the cached local stores; localWatched is false while the watch fails.
    this.localGen = 0;
    this.localWatched = false;
    // Remote home lookup via lib/home.js (sh, then cmd.exe; failures back
    // off and retry). Local machines answer straight from herdr's home().
    this.homeFor = homeCache(exec, home);
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
    this.watchLocalTasks(cx);
    cx.timer.every(2000, (cx) => this.tick(cx));
    this.tick(cx);
  }

  /** Watches ~/.herdr/ranch/tasks (it may not exist yet: retried every 3 s). */
  watchLocalTasks(cx) {
    if (this.watching) return;
    this.watching = true;
    const dir = `${home()}/${TASKS_DIR}`;
    cx.spawn(async (cx) => {
      for (;;) {
        this.localWatched = true;
        try {
          await watchFolder(dir);
        } catch {
          this.localWatched = false;
          this.localGen++;
          await cx.sleep(3000);
          continue;
        }
        this.localGen++;
      }
    });
  }

  /** Can a cached store still be used for `machine` (null: this computer)? */
  storeFresh(cached, machine, now = Date.now()) {
    const age = now - cached.at;
    if (machine != null) return age < REMOTE_STORE_TTL;
    // Watched: valid until the folder changes (gen moves on), up to 30 s.
    if (this.localWatched) return cached.gen === this.localGen && age < LOCAL_WATCHED_TTL;
    return age < STORE_TTL;
  }

  /** One cheap, idempotent pass over all tabs; async work happens in a spawn. */
  tick(cx) {
    // A slow pass (remote exec) must not overlap the next tick, but a stalled
    // one is replaced; its late results are dropped by generation.
    if (this.running && Date.now() - (this.runningAt ?? 0) < PASS_STALL_MS) return;
    const gen = (this.passGen = (this.passGen ?? 0) + 1);
    this.running = true;
    this.runningAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        await this.pass(gen);
      } catch (err) {
        this.logOnce(err);
      } finally {
        if (gen === this.passGen) this.running = false;
      }
    });
  }

  logOnce(err) {
    const msg = String(err?.message ?? err);
    if (this.logged.has(msg)) return;
    this.logged.add(msg);
    console.log(`ranch-sidebar namer: ${msg}`);
  }

  /** False once a newer pass has replaced the one numbered `gen`. */
  current(gen) {
    return gen == null || gen === this.passGen;
  }

  async pass(gen) {
    const settings = resolveSettings(shared(SETTINGS_KEY));
    if (shared("layout") !== "ranch") return;
    const agentsNow = agents();
    const panesNow = panes();
    const terminalsNow = terminals();
    const seen = new Set();
    const activity = {};
    for (const space of spaces()) {
      for (const tab of space.tabs) {
        seen.add(tab.id);
        try {
          // Activity from Ranch's hooks, for tabs where Herdr shows no status.
          const agent = pickNamingAgent({ tabId: tab.id, agents: agentsNow, panes: panesNow, terminals: terminalsNow })
            ?? paneAgent(panesNow, tab.id);
          if (agent) {
            const store = await this.loadStore(agent.address, space.machine, agent.app);
            if (!this.current(gen)) return;
            const act = store?.session?.activity;
            // Herdr sub-agents belong to their parent's tab, so any agent in the
            // tab may be the parent (the first one found could be a child).
            const now = Date.now();
            const parents = new Set([agent.address, ...agentsNow.filter((a) => a.tab === tab.id).map((a) => a.address)]);
            const subs = subagentsWorking({ terminals: terminalsNow, parent: agent.address, subagents: store?.subagents, now })
              || [...parents].some((p) => subagentsWorking({ terminals: terminalsNow, parent: p, now }));
            if (act || subs) activity[tab.id] = subs ? { ...(act ?? {}), subsWorking: true } : act;
          }
          if (settings.naming.enabled) await this.handleTab(space, tab, agentsNow, panesNow, settings, terminalsNow, gen);
          if (!this.current(gen)) return;
        } catch (err) {
          this.logOnce(err);
        }
      }
    }
    if (!this.current(gen)) return;
    if (JSON.stringify(activity) !== JSON.stringify(shared(ACTIVITY_KEY) ?? {})) setShared(ACTIVITY_KEY, activity);
    for (const id of this.prev.keys()) {
      if (!seen.has(id)) {
        this.prev.delete(id);
        this.locked.delete(id);
      }
    }
  }

  async handleTab(space, tab, agentsAll, panesAll, settings, terminalsAll = [], gen = null) {
    const naming = settings.naming;
    // An agent whose status report was cleared (Herdr shows status null) is
    // still an agent session: fall back to a pane running a known agent app.
    const agent = pickNamingAgent({ tabId: tab.id, agents: agentsAll, panes: panesAll, terminals: terminalsAll })
      ?? paneAgent(panesAll, tab.id);
    const prev = this.prev.get(tab.id) ?? {};

    let store = null;
    let pane = null;
    if (agent) {
      pane = panesAll.find((p) => p.pane === agent.pane) ?? null;
      store = await this.loadStore(agent.address, space.machine, agent.app);
      if (!this.current(gen)) return; // replaced while reading: act on nothing stale
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

    const record = withRecordSession(shared(AUTONAMES_KEY)?.[tab.id], shared(SESSIONS_KEY));
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
      context: [space.name],
    });

    // Optional model summary (R-TN-6): once per session, one attempt at most.
    if (naming.model && candidate?.source === "prompt" && store?.session?.id && store.session.first_prompt) {
      candidate = await this.modelTitle(store.session, candidate);
      if (!this.current(gen)) return;
    }

    // Resume: a known session id on an unnamed tab restores its last name.
    if (own === "unnamed" && store?.session?.id && !record) {
      const recalled = recallSession(shared(SESSIONS_KEY) ?? {}, store.session.id);
      if (recalled) candidate = { name: recalled, source: "agent_auto" };
    }

    // Session switch in the same agent (Pi /resume, Claude /resume…): the
    // resumed session's remembered name beats a weaker fresh guess.
    const sessionId = store?.session?.id ?? null;
    if (own === "auto" && sessionChanged(record, sessionId)) {
      const recalled = recallSession(shared(SESSIONS_KEY) ?? {}, sessionId);
      if (recalled && (!candidate || SOURCE_RANK[candidate.source] > SOURCE_RANK.agent_auto)) {
        candidate = { name: recalled, source: "agent_auto" };
      }
    }

    const result = decide({
      tab,
      record,
      candidate,
      now: Date.now(),
      editing: this.isEditing(tab.id),
      siblingNames: space.tabs.filter((t) => t.id !== tab.id).map((t) => t.name),
      branch: pane?.branch ?? null,
      sessionId,
    });

    if (result.action === "rename") {
      this.applyRename(space, tab, result, sessionId);
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
      [tab.id]: {
        name: result.name, source: result.source, prev: tab.named ? tab.name : null, at: Date.now(),
        // The session this name was for; a different one lifts the rank/throttle guard.
        session: sessionId ?? shared(AUTONAMES_KEY)?.[tab.id]?.session ?? null,
      },
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

  async loadStore(address, machine, app) {
    // A remote agent's store is named by its machine-local terminal id.
    const local = storeAddress(address, machine);
    const [terminal, legacy] = storeCandidates(local);
    if (!terminal) return null;
    const cached = this.stores.get(address);
    if (cached && this.storeFresh(cached, machine)) return cached.store;
    // A change while the read runs leaves gen behind: the next tick re-reads.
    const gen = this.localGen;
    let store = null;
    try {
      const dir = await this.homeFor(machine);
      if (dir) {
        const terminalText = await readTextFile(`${dir}/${TASKS_DIR}/${terminal}`, { on: machine });
        const [session] = terminalText == null ? [] : storeCandidates(local, terminalText);
        const file = session ?? (terminalText == null ? legacy : terminal);
        const text = terminalText == null || session
          ? await readTextFile(`${dir}/${TASKS_DIR}/${file}`, { on: machine })
          : terminalText;
        const parsed = withPointerIdentity(parseStore(text), terminalText);
        if (listVisible(parsed, { app })) store = parsed.store;
      }
    } catch (err) {
      this.logOnce(err);
    }
    this.stores.set(address, { store, at: Date.now(), gen });
    return store;
  }

  // Remote home lookup lives in this.homeFor (lib/home.js cache, set up in
  // the constructor).
}
