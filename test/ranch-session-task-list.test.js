// Focused GPUI structure tests for the Session Details task-list viewport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

globalThis.localStorage = { getItem: () => null, setItem() {} };

const herdrSource = `
export const exec = () => new Promise(() => {});
export const home = () => "/home/u";
export const readTextFile = () => Promise.resolve(null);
export const watchFolder = () => new Promise(() => {});
export const spaces = () => [];
export const agents = () => [];
export const panes = () => [];
export const terminals = () => [];
export const focused = () => null;
export const theme = () => new Proxy({}, { get: () => "#fff" });
export const run = () => {};
export const shared = () => undefined;
export const setShared = () => {};
export const layout = () => null;
export const window = () => ({ platform: "macos" });
`;

const chainSource = `
const make = (kind) => {
  const data = { kind, calls: [], children: [] };
  let proxy;
  proxy = new Proxy(() => {}, {
    get: (_target, property) => {
      if (property === "__element") return data;
      if (property === Symbol.toPrimitive) return () => "";
      return (...args) => {
        if (property === "child") data.children.push(args[0]);
        else if (property === "children") data.children.push(...args[0]);
        else if (property === "when" && args[0]) args[1](proxy);
        data.calls.push([property, args]);
        return proxy;
      };
    },
  });
  return proxy;
};
export const makeElement = make;
`;

const gpuiKitSource = `
${chainSource}
export class View {}
export const div = () => makeElement("div");
export const svg = () => makeElement("svg");
export const image = () => makeElement("image");
`;

const gpuiBaseSource = `
${chainSource}
export const v_flex = () => makeElement("v_flex");
export const h_flex = () => makeElement("h_flex");
`;

const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "herdr") return { url: data(herdrSource), shortCircuit: true };
    if (specifier === "gpui-kit") return { url: data(gpuiKitSource), shortCircuit: true };
    if (specifier === "gpui-base") return { url: data(gpuiBaseSource), shortCircuit: true };
    return nextResolve(specifier, _context);
  },
});

const RanchSession = (await import(join(root, "mods/ranch-session/main.js"))).default;
const t = new Proxy({}, { get: () => "#fff" });
const node = (element) => element.__element;
const call = (element, name) => node(element).calls.find(([method]) => method === name)?.[1];
const descendants = (element) => [
  node(element),
  ...node(element).children
    .filter((child) => child && (typeof child === "object" || typeof child === "function"))
    .flatMap(descendants),
];
const tasks = (count) => Array.from({ length: count }, (_, index) => ({
  id: String(index + 1),
  title: `Task ${index + 1}`,
  status: index === count - 1 && count > 5 ? "cancelled" : "pending",
  active_form: null,
}));

test("five task rows keep natural height and have no overflow fade", () => {
  const view = new RanchSession();
  const list = view.taskList(t, tasks(5), "agent-a", false);
  assert.equal(call(list, "id")?.[0], "tasks-list-agent-a");
  assert.equal(call(list, "overflow_y_scrollbar"), undefined);
  assert.equal(node(list).children.length, 5);
  assert.equal(descendants(list).some((n) => n.calls.some(([m, a]) => m === "id" && a[0] === "tasks-fade-agent-a")), false);
});

test("six task rows use a five-row scroll viewport without dropping cancelled tasks", () => {
  const view = new RanchSession();
  const viewport = view.taskList(t, tasks(6), "agent-a", false);
  assert.deepEqual(call(viewport, "h")?.slice(0, 1), [120]);
  const list = node(viewport).children[0];
  assert.equal(call(list, "overflow_y_scrollbar") !== undefined, true);
  assert.deepEqual(call(list, "h")?.slice(0, 1), [120]);
  assert.equal(node(list).children.length, 6);
  assert.equal(call(node(list).children.at(-1), "id")?.[0], "task-agent-a-6");
  assert.equal(call(node(viewport).children[1], "id")?.[0], "tasks-fade-agent-a");
});

test("task scroll regions and fades have agent-specific ids", () => {
  const view = new RanchSession();
  const a = view.taskList(t, tasks(6), "agent-a", false);
  const b = view.taskList(t, tasks(6), "agent-b", false);
  assert.equal(call(node(a).children[0], "id")?.[0], "tasks-list-agent-a");
  assert.equal(call(node(b).children[0], "id")?.[0], "tasks-list-agent-b");
  assert.equal(call(node(a).children[1], "id")?.[0], "tasks-fade-agent-a");
  assert.equal(call(node(b).children[1], "id")?.[0], "tasks-fade-agent-b");
});
