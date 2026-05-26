/**
 * Thread Dashboard v2 — Agent View-style grouping + inline reply + search
 * Groups: Needs Input | Working | Done
 * Keys: ↑↓ navigate, Enter expand, i reply, / search, k kill, p prune, q close
 */
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { ThreadRegistry } from "./core/registry.js";

export interface DashboardTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

interface Row {
	id: string;
	kind: "thread" | "story";
	label: string;
	state: string;
	progress: string;
	elapsed: string;
	result: string;
	error: string;
	type: string;
}

interface Group {
	name: string;
	icon: string;
	color: string;
	rows: Row[];
}

export function createDashboard(
	registry: ThreadRegistry,
	theme: DashboardTheme,
	onClose: () => void,
	onKill?: (id: string) => void,
	onReview?: (id: string) => void,
	onReply?: (id: string, message: string) => void,
	onExport?: (id: string) => void
) {
	let selected = 0;
	let expanded: string | null = null;
	let searchQuery = "";
	let showSearch = false;
	let replyTarget: string | null = null;
	let replyBuffer = "";
	let groups: Group[] = [];
	let pinned = new Set<string>();
	let cachedWidth: number | undefined;

	// Safety: cap at 100 rows to prevent terminal overflow
	const MAX_ROWS = 100;

	function stateIcon(state: string): string {
		switch (state) {
			case "running": return "⟳";
			case "completed": return "✓";
			case "failed": case "killed": return "✗";
			case "pending": return "·";
			case "planning": return "📋";
			case "executing": return "⚡";
			case "verifying": return "🔍";
			case "done": return "✅";
			case "needs_input": return "⚠";
			case "approved": return "✅";
			case "rejected": return "✗";
			default: return "?";
		}
	}

	function stateColor(state: string): string {
		switch (state) {
			case "running": case "executing": return "warning";
			case "completed": case "done": case "approved": return "success";
			case "failed": case "killed": case "rejected": return "error";
			case "needs_input": return "warning";
			default: return "muted";
		}
	}

	function typeIcon(type: string): string {
		switch (type) {
			case "parallel": return "⫘";
			case "chained": return "⟶";
			case "fusion": return "⊕";
			case "meta": return "◎";
			case "long": return "∞";
			case "zero": return "⊘";
			case "worktree": return "🌳";
			case "plan": return "📋";
			case "scheduled": return "⏰";
			default: return "·";
		}
	}

	function buildGroups(): Group[] {
		const allThreads = registry.all();
		const allStories = registry.allStories();

		const needsInput: Row[] = [];
		const working: Row[] = [];
		const done: Row[] = [];

		for (const t of allThreads) {
			const sum = registry.summarize(t);
			const row: Row = {
				id: sum.id,
				kind: "thread",
				label: sum.label,
				state: sum.state,
				progress: sum.progress,
				elapsed: sum.elapsed,
				result: t.tasks.find(x => x.result)?.result?.slice(0, 80) ?? "",
				error: t.tasks.find(x => x.error)?.error?.slice(0, 80) ?? "",
				type: t.type ?? "",
			};
			if (sum.state === "needs_input") needsInput.push(row);
			else if (["running", "pending", "executing", "verifying", "planning"].includes(sum.state as string)) working.push(row);
			else done.push(row);
		}

		for (const s of allStories) {
			const row: Row = {
				id: s.id,
				kind: "story",
				label: s.goal,
				state: s.state,
				progress: "",
				elapsed: "",
				result: "",
				error: "",
				type: "story",
			};
			if ((s.state as string) === "done" || (s.state as string) === "failed" || (s.state as string) === "completed") done.push(row);
			else working.push(row);
		}

		// Separate pinned rows
		const allPinned: Row[] = [];
		const needsInputNormal: Row[] = [];
		const workingNormal: Row[] = [];
		const doneNormal: Row[] = [];
		for (const r of needsInput) { if (pinned.has(r.id)) allPinned.push(r); else needsInputNormal.push(r); }
		for (const r of working) { if (pinned.has(r.id)) allPinned.push(r); else workingNormal.push(r); }
		for (const r of done) { if (pinned.has(r.id)) allPinned.push(r); else doneNormal.push(r); }

		const result: Group[] = [];
		if (allPinned.length > 0) result.push({ name: "Pinned", icon: "📌", color: "accent", rows: allPinned });
		if (needsInputNormal.length > 0) result.push({ name: "Needs Input", icon: "⚠", color: "warning", rows: needsInputNormal });
		if (workingNormal.length > 0) result.push({ name: "Working", icon: "⟳", color: "warning", rows: workingNormal });
		if (doneNormal.length > 0) result.push({ name: "Done", icon: "✓", color: "success", rows: doneNormal });

		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			for (const g of result) {
				g.rows = g.rows.filter(r => r.label.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
			}
		}

		for (const g of result) {
			if (g.rows.length > MAX_ROWS) g.rows.length = MAX_ROWS;
		}

		return result.filter(g => g.rows.length > 0);
	}

	function totalRows(): number {
		let n = 0;
		for (const g of groups) n += g.rows.length;
		return n;
	}

	function getSelected(): { group: number; row: number } | null {
		let idx = 0;
		for (let gi = 0; gi < groups.length; gi++) {
			for (let ri = 0; ri < groups[gi].rows.length; ri++) {
				if (idx === selected) return { group: gi, row: ri };
				idx++;
			}
		}
		return null;
	}

	function ensureGroups() {
		if (groups.length === 0) groups = buildGroups();
	}

	function renderExpanded(id: string, width: number): string[] {
		const lines: string[] = [];
		const indent = "    ";
		const maxW = width - 6;

		const t = registry.get(id);
		if (t) {
			lines.push(theme.fg("accent", theme.bold(`  Thread ${t.id} (${t.type}) — ${t.state}`)));
			lines.push("");
			for (const task of t.tasks) {
				const icon = stateIcon(task.state);
				const color = stateColor(task.state);
				lines.push(theme.fg(color, `${indent}${icon} ${task.id}: ${truncateToWidth(task.label, maxW)}`));
				if (task.model) lines.push(theme.fg("dim", `${indent}  model: ${task.model}`));
				if (task.usage) {
					const costStr = task.usage.cost > 0 ? ` ${task.usage.cost.toFixed(4)}` : "";
					lines.push(theme.fg("dim", `${indent}  tokens: ${task.usage.totalTokens}${costStr}`));
				}
				if (task.result) {
					const preview = task.result.replace(/\n/g, " ").slice(0, 200);
					lines.push(theme.fg("muted", `${indent}  → ${truncateToWidth(preview, maxW)}`));
				}
				if (task.error) {
					lines.push(theme.fg("error", `${indent}  ✗ ${truncateToWidth(task.error, maxW)}`));
				}
			}
			return lines;
		}

		const s = registry.getStory(id);
		if (s) {
			lines.push(theme.fg("accent", theme.bold(`  Story ${s.id} — ${s.state}`)));
			lines.push(theme.fg("muted", `  ${s.goal}`));
			lines.push("");
			for (const phase of s.phases) {
				const icon = stateIcon(phase.state);
				const color = stateColor(phase.state);
				const tid = phase.threadId ? theme.fg("dim", ` [${phase.threadId}]`) : "";
				lines.push(theme.fg(color, `${indent}${icon} ${phase.name} (${phase.threadType})${tid}`));
				lines.push(theme.fg("dim", `${indent}  ${truncateToWidth(phase.description, maxW)}`));
			}
			return lines;
		}

		return [theme.fg("error", `  ${id} not found`)];
	}

	function tw(s: string, w: number): string {
		return truncateToWidth(s, Math.max(1, w));
	}

	const component = {
		handleInput(data: string) {
			if (replyTarget !== null) {
				if (matchesKey(data, Key.enter)) {
					onReply?.(replyTarget, replyBuffer);
					replyTarget = null;
					replyBuffer = "";
					cachedWidth = undefined;
				} else if (matchesKey(data, Key.escape)) {
					replyTarget = null;
					replyBuffer = "";
					cachedWidth = undefined;
				} else if (data.length === 1 && !data.startsWith("\x1b") && data !== "[" && data !== "o") {
					replyBuffer += data;
					cachedWidth = undefined;
				} else if (data === "Backspace" || data === "\x7f") {
					replyBuffer = replyBuffer.slice(0, -1);
					cachedWidth = undefined;
				}
				return;
			}

			if (matchesKey(data, Key.escape) || data === "q") {
				onClose();
				return;
			}
			if (data === "/") {
				showSearch = !showSearch;
				if (!showSearch) { searchQuery = ""; }
				cachedWidth = undefined;
				return;
			}
			if (showSearch && data.length === 1) {
				searchQuery += data;
				cachedWidth = undefined;
				return;
			}
			if (showSearch && (data === "Backspace" || data === "\x7f")) {
				searchQuery = searchQuery.slice(0, -1);
				cachedWidth = undefined;
				return;
			}

			const total = totalRows();
			if (matchesKey(data, Key.up) && selected > 0) { selected--; ensureGroups(); }
			if (matchesKey(data, Key.down) && selected < total - 1) { selected++; ensureGroups(); }

			if (data === "i") {
				const sel = getSelected();
				if (sel) {
					replyTarget = groups[sel.group].rows[sel.row].id;
					replyBuffer = "";
					cachedWidth = undefined;
				}
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const sel = getSelected();
				if (sel) {
					const id = groups[sel.group].rows[sel.row].id;
					expanded = expanded === id ? null : id;
					cachedWidth = undefined;
				}
				return;
			}
			if (data === "e") {
				const sel = getSelected();
				if (sel) { onExport?.(groups[sel.group].rows[sel.row].id); cachedWidth = undefined; }
				return;
			}

			if (data === "k") {
				const sel = getSelected();
				if (sel) { onKill?.(groups[sel.group].rows[sel.row].id); cachedWidth = undefined; }
				return;
			}
			if (data === "r") {
				const sel = getSelected();
				if (sel) { onReview?.(groups[sel.group].rows[sel.row].id); cachedWidth = undefined; }
				return;
			}
			if (data === "p") { registry.prune(); ensureGroups(); cachedWidth = undefined; }
			if (data === "P") {
				const sel = getSelected();
				if (sel) {
					const id = groups[sel.group].rows[sel.row].id;
					if (pinned.has(id)) pinned.delete(id); else pinned.add(id);
					cachedWidth = undefined;
				}
				return;
			}
		},

		render(width: number): string[] {
			groups = buildGroups();
			const total = totalRows();
			if (selected >= total && total > 0) selected = total - 1;

			const lines: string[] = [];
			const border = "─".repeat(Math.min(width - 4, 80));

			lines.push("");
			lines.push(theme.fg("accent", theme.bold("  🧵 Thread Dashboard")));
			lines.push(theme.fg("dim", `  ${tw(border, width)}`));

			if (groups.length === 0 && total === 0) {
				lines.push("");
				lines.push(theme.fg("muted", "  No threads or stories."));
				lines.push(theme.fg("dim", "  Use /pthread /fthread /zthread /story to start."));
			} else {
				let flatIdx = 0;
				for (const g of groups) {
					// Group header
					const gColor = g.color === "success" ? "success" : "accent";
					lines.push("");
					lines.push(theme.fg(gColor, `  ${g.icon} ${g.name} (${g.rows.length})`));

					for (const row of g.rows) {
						const isSelected = flatIdx === selected;
						const prefix = isSelected ? theme.fg("accent", " ▸ ") : "   ";

						let display: string;
						if (row.kind === "story") {
							const s = registry.getStory(row.id);
							if (s) {
								const phases = s.phases.map(p => `${stateIcon(p.state)}${p.name}`).join("→");
								display = `📖 ${theme.fg("accent", row.id)} [${theme.fg(stateColor(row.state), row.state)}] ${tw(row.label, 22)} ${theme.fg("dim", tw(phases, 16))}`;
							} else {
								display = `📖 ${theme.fg("accent", row.id)} ${tw(row.label, 50)}`;
							}
						} else {
							// Thread with progress bar + last output snippet
							let progressBar = "░░░░░░░░░░";
							if (row.result) {
								progressBar = "██████████"; // done
							} else if (row.state === "running" || row.state === "executing") {
								progressBar = "████░░░░░░"; // in progress
							} else if (row.state === "failed") {
								progressBar = "✗✗✗✗✗✗✗✗✗✗"; // failed
							}
							const pinMark = pinned.has(row.id) ? "📌" : "  ";
							const snippet = row.result
								? `→${row.result.slice(0, 40)}`
								: row.error
									? `✗${row.error.slice(0, 40)}`
								: row.elapsed
									? `⏱${row.elapsed}`
								: "";
							display = `${pinMark}${typeIcon(row.type)} ${theme.fg("accent", row.id)} ${progressBar} [${theme.fg(stateColor(row.state), row.state)}] ${tw(row.label, 20)} ${theme.fg("muted", tw(snippet, 22))}`;
						}

						lines.push(tw(prefix + display, width));

						if (isSelected && expanded === row.id) {
							lines.push(...renderExpanded(row.id, width));
							lines.push("");
						}
						flatIdx++;
					}
				}
			}

			// Reply mode banner
			if (replyTarget !== null) {
				lines.push("");
				lines.push(tw(theme.fg("warning", theme.bold("  ┌─ REPLY ─────────────────────────────┐")), width));
				lines.push(tw(theme.fg("warning", `  │ ${tw(replyTarget || "", 28).padEnd(28)} │`), width));
				lines.push(tw(theme.fg("warning", `  │ ${tw(replyBuffer || "(type message)", 28).padEnd(28)} │`), width));
				lines.push(tw(theme.fg("warning", `  │ Enter=send  Esc=cancel               │`), width));
				lines.push(tw(theme.fg("warning", theme.bold("  └──────────────────────────────────────┘")), width));
			}

			// Footer
			lines.push("");
			lines.push(theme.fg("dim", `  ${tw(border, width)}`));
			const help = showSearch
				? tw(`Search: ${searchQuery}_  Enter done  Esc cancel`, width - 4)
				: tw("nav=↑↓ exp=Enter rep=i srch=/ kill=k rev=r export=e pin=P prune=p quit=q", width - 4);
			lines.push(theme.fg("dim", `  ${help}`));
			lines.push("");

			// Final safety: truncate ALL lines
			return lines.map(l => tw(l, width));
		},

		invalidate() {
			cachedWidth = undefined;
		},
	};

	return component;
}