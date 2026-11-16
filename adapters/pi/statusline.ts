/**
 * Minimal status line for pi.
 *
 *   myapp  main                              68k / 200k  ·  $0.12  ·  claude-opus-5-5 high
 *
 * Monochrome (muted/dim theme tokens), with warning/error tints only when
 * the context window is filling up. Toggle with /statusline.
 */

import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let requestRender: (() => void) | undefined;

	function install(ctx: ExtensionContext) {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const sep = theme.fg("dim", "  ·  ");

			return {
				dispose() {
					unsub();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const inner = Math.max(0, width - 2); // 1-col margin each side

					// left: folder name + git branch
					const folder = theme.fg("muted", basename(ctx.cwd) || ctx.cwd);
					const branch = footerData.getGitBranch();
					const leftFull = branch ? `${folder}  ${theme.fg("dim", branch)}` : folder;

					// right: context, cost, model
					let cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							cost += (e.message as AssistantMessage).usage.cost.total;
						}
					}
					const usage = ctx.getContextUsage();
					const pct = usage?.percent ?? null;
					const windowSize = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const used = usage?.tokens ?? null;
					const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
					const usedText = used == null ? "–" : k(used);
					const totalText = k(windowSize);
					const tint = pct != null && pct > 90 ? "error" : pct != null && pct > 70 ? "warning" : "muted";
					const ctxStr =
						theme.fg(tint, usedText) + theme.fg("dim", " / ") + theme.fg("dim", totalText);
					const model = ctx.model;
					const level = pi.getThinkingLevel() || "off";
					const modelStr =
						theme.fg("muted", model?.id ?? "no model") +
						(model?.reasoning && level !== "off" ? theme.fg("dim", ` ${level}`) : "");
					const costStr = cost > 0 ? theme.fg("muted", `$${cost.toFixed(2)}`) : "";

					const join = (parts: string[]) => parts.filter(Boolean).join(sep);
					// Priority when narrowing: drop cost, then branch, then model.
					const layouts: [string, string][] = [
						[leftFull, join([ctxStr, costStr, modelStr])],
						[leftFull, join([ctxStr, modelStr])],
						[folder, join([ctxStr, modelStr])],
						[folder, ctxStr],
					];

					let line = "";
					for (const [left, right] of layouts) {
						const gap = inner - visibleWidth(left) - visibleWidth(right);
						if (gap >= 2) {
							line = left + " ".repeat(gap) + right;
							break;
						}
					}
					if (!line) line = truncateToWidth(folder, inner);

					const lines = [` ${line} `];

					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, t]) => t.replace(/[\r\n]+/g, " "));
					if (statuses.length) lines.push(` ${truncateToWidth(statuses.join(sep), inner)}`);
					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_e, ctx) => {
		if (enabled) install(ctx);
	});
	pi.on("turn_end", async () => requestRender?.());
	pi.on("agent_end", async () => requestRender?.());
	pi.on("model_select", async () => requestRender?.());
	pi.on("thinking_level_select", async () => requestRender?.());

	pi.registerCommand("statusline", {
		description: "Toggle the minimal status line",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) install(ctx);
			else ctx.ui.setFooter(undefined);
			ctx.ui.notify(`Status line ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
