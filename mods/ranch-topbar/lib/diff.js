// Unified-diff helpers shared by the Changes panel and the file viewer tab's
// diff mode. No imports: copied into every mod by scripts/sync-lib.sh.

/** Lines drawn per diff, and characters per line, before truncating. */
export const MAX_LINES = 1500;
export const MAX_LINE = 4000;

/** Lines in a text, ignoring the empty line after a trailing newline. */
export const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

/** Cuts one very long line. */
export const capLine = (line) => line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "… (line truncated)" : line;

/** Text draws a tab as nothing: pad each to the next 4-column stop. */
export const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

/**
 * Numbers each diff line once, so a frame only draws the rows on screen.
 * @param {string[]} lines from the first "@@" on
 * @returns {Array<{kind: "@"|"+"|"-"|" "|"", number?: number, text: string}>}
 */
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

/** `git diff` output from its first hunk, capped; a note when there is none. */
export function hunkLines(text, empty = "No text diff available") {
  const all = String(text ?? "").replace(/\n$/, "").split("\n");
  const first = all.findIndex((l) => l.startsWith("@@"));
  return (first < 0 ? [empty] : all.slice(first)).slice(0, MAX_LINES).map(capLine);
}

/** An untracked file as an all-added diff. */
export function addedLines(text) {
  const n = countLines(text);
  return [`@@ -0,0 +1,${n} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, MAX_LINES).map((l) => capLine(`+${l}`))];
}

/** Added and removed line counts of diff rows. */
export function diffStats(rows) {
  let add = 0, del = 0;
  for (const row of rows) { if (row.kind === "+") add++; else if (row.kind === "-") del++; }
  return { add, del };
}

/** Pixel width the widest row needs (monospace at ~7 px per character). */
export const diffWidth = (rows) => Math.max(300, ...rows.map((row) => (row.text.length + 1) * 7 + 50));

/**
 * `git diff` arguments for one changed file of a status group. Staged diffs
 * work before the first commit too (no HEAD argument needed).
 * @param {"staged"|"unstaged"|"conflicts"} group
 */
export function diffArgs(group, path) {
  return [...(group === "staged" ? ["diff", "--cached"] : ["diff"]), "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
}
