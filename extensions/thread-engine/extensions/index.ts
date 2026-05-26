import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

// StringEnum helper (removed from pi-ai >=0.66)
function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as unknown as string[],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
import { ThreadRegistry, formatElapsed } from "../src/core/registry.js";
import { ThreadExecutor } from "../src/core/executor.js";
import { createDashboard } from "../src/dashboard.js";
import type { Thread, ThreadType, Story, StoryPhase } from "../src/core/types.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { createWorktree, removeWorktree, listWorktrees, pushWorktreeChanges, cleanupAll, isGitRepo, branchName, findRepoRoot } from "../src/core/worktree.js";

// ── Export helper ───────────────────────────────────────────
function exportThread(id: string, r: ThreadRegistry, cwd: string): string | null {
	const t = r.get(id);
	const s = r.getStory(id);
	if (!t && !s) return null;
	const md = ["# pi-thread-engine Export"];
	const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
	const fn = "thread-" + id + "-" + ts + ".md";
	const outPath = join(cwd, fn);
	if (s) { md.push("## Story: " + s.id); md.push("Goal: " + s.goal); }
	if (t) {
		const sum = r.summarize(t);
		md.push("## " + sum.id + ": " + sum.type + " - " + sum.label);
		for (const tk of t.tasks) {
			const snip = tk.result ? tk.result.slice(0, 200).replace(/\n/g, " ") : tk.error ? "ERROR: " + tk.error.slice(0, 200) : "(no result)";
			md.push("- " + tk.id + " [" + tk.state + "]: " + snip);
		}
	}
	writeFileSync(outPath, md.join("\n"), "utf8");
	return outPath;
}

export default function (pi: ExtensionAPI) {
	const registry = new ThreadRegistry();
	const executor = new ThreadExecutor(pi, registry);

	// ── Session persistence ──────────────────────────────────────
	// Persist thread/story state so it survives compaction and /fork

	function persistState() {
		const threads = registry.all().filter((t) => t.state !== "killed");
		const stories = registry.allStories();
		if (threads.length > 0 || stories.length > 0) {
			pi.appendEntry("pi-threads-state", { threads, stories, timestamp: Date.now() });
		}
	}

	// Save state on thread events
	registry.on((event) => {
		if (event.type === "thread_completed" || event.type === "thread_failed" ||
			event.type === "story_completed" || event.type === "story_failed") {
			persistState();
		}
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "pi-threads-state") {
				const data = entry.data as { threads?: Thread[]; stories?: Story[]; timestamp?: number };
				if (data?.threads) {
					registry.restore(data.threads, data.stories ?? []);
				}
			}
		}
	});

	// ── Status bar ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		registry.on(() => {
			const running = registry.byState("running");
			const stories = registry.allStories().filter((s) => s.state === "executing" || s.state === "planning");
			const parts: string[] = [];

			if (stories.length > 0) {
				parts.push(`📖${stories.length}`);
			}
			if (running.length > 0) {
				parts.push(
					...running.map((t) => {
						const sum = registry.summarize(t);
						return `🧵${sum.type[0].toUpperCase()}:${sum.progress}`;
					})
				);
			}

			ctx.ui.setStatus("pi-threads", parts.length > 0 ? parts.join(" ") : undefined);
		});
	});

	// ── Keyboard shortcut ────────────────────────────────────────

	pi.registerShortcut("ctrl+shift+t", {
		description: "Open thread dashboard",
		handler: async (ctx) => {
			// Trigger the /threads command
			pi.sendUserMessage("/threads", { deliverAs: "followUp" });
		},
	});

	// ── Helpers ──────────────────────────────────────────────────

	function parseTaskArgs(args: string): string[] {
		const tasks: string[] = [];
		const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(args))) {
			tasks.push(m[1] ?? m[2] ?? m[3]);
		}
		return tasks;
	}

	function stateIcon(state: string): string {
		switch (state) {
			case "running": return "⟳";
			case "completed": return "✓";
			case "failed": return "✗";
			case "killed": return "☠";
			case "pending": return "·";
			default: return "?";
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
			default: return "·";
		}
	}

	// ── /threads — unified TUI dashboard ─────────────────────────

	pi.registerCommand("threads", {
		description: "Thread dashboard — interactive TUI to view/manage threads and stories",
		handler: async (args, ctx) => {
			const subcmd = args?.trim().split(/\s+/)[0] ?? "";
			const rest = args?.trim().slice(subcmd.length).trim() ?? "";

			// Quick subcommands (no TUI)
			if (subcmd === "kill" && rest) {
				const t = registry.get(rest);
				if (!t) { ctx.ui.notify(`Thread ${rest} not found`, "error"); return; }
				registry.kill(rest);
				ctx.ui.notify(`Killed ${rest}`, "warning");
				return;
			}
			if (subcmd === "prune") {
				registry.prune();
				ctx.ui.notify("Pruned finished threads", "info");
				return;
			}
			if (subcmd === "status") {
				// Quick text status (no TUI)
				const threads = registry.all();
				const stories = registry.allStories();
				if (threads.length === 0 && stories.length === 0) {
					ctx.ui.notify("No active threads or stories.", "info");
					return;
				}
				const lines: string[] = [];
				for (const s of stories) {
					const phases = s.phases.map((p) => `${stateIcon(p.state)}${p.name}`).join("→");
					lines.push(`📖 ${s.id} [${s.state}] ${s.goal.slice(0, 50)} — ${phases}`);
				}
				for (const t of threads) {
					const sum = registry.summarize(t);
					lines.push(`🧵 ${sum.id} ${sum.type} [${sum.state}] ${sum.progress} (${sum.elapsed}) — ${sum.label}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (subcmd === "review") {
				const completed = registry.byState("completed");
				if (completed.length === 0) { ctx.ui.notify("No completed threads to review", "info"); return; }
				for (const t of completed) {
					const lines: string[] = [`── Thread ${t.id} (${t.type}) ──`];
					if (t.type === "fusion") {
						lines.push("Fusion results — compare and pick the best:\n");
						for (const tk of t.tasks) {
							const modelTag = tk.model ? ` [${tk.model}]` : "";
							lines.push(`═══ ${tk.id}${modelTag} (${tk.state}) ═══`);
							lines.push(tk.result?.slice(0, 800) ?? tk.error ?? "(no output)");
							lines.push("");
						}
					} else {
						for (const tk of t.tasks) {
							lines.push(`  ${stateIcon(tk.state)} ${tk.id}: ${tk.label}`);
							if (tk.result) lines.push(`    ${tk.result.slice(0, 300)}`);
							if (tk.error) lines.push(`    ERROR: ${tk.error.slice(0, 200)}`);
						}
					}
					ctx.ui.notify(lines.join("\n"), "info");
				}
				return;
			}

			// ── /threads export ──
			if (subcmd === "export") {
				const exportAll = rest === "--all" || rest === "-a";
				const exportId = !exportAll && rest ? rest : null;
				const src = exportAll ? registry.all() : exportId ? [registry.get(exportId)].filter(Boolean) : [];
				const stSrc = exportAll ? registry.allStories() : exportId ? [registry.getStory(exportId)].filter(Boolean) : [];
				if (src.length === 0 && stSrc.length === 0) {
					ctx.ui.notify("Nothing to export", "info");
					return;
				}
				const md = ["# pi-thread-engine Export", ""];
				for (const s of stSrc) {
					md.push("## Story: " + s.id);
					md.push("Goal: " + s.goal);
					md.push("State: " + s.state);
				}
				for (const t of src) {
					const sum = registry.summarize(t);
					md.push("## " + sum.id + ": " + sum.type);
					md.push("Label: " + sum.label);
					md.push("State: " + sum.state);
					for (const tk of t.tasks) {
						md.push("- " + tk.id + " [" + tk.state + "]: " + (tk.result ? tk.result.slice(0, 200) : tk.error ? "ERROR: " + tk.error.slice(0, 200) : "(no result)"));
					}
				}
				const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
				const fn = "threads-" + ts + ".md";
				const outPath = require("path").join(ctx.cwd, fn);
				require("fs").writeFileSync(outPath, md.join("\n"), "utf8");
				ctx.ui.notify("Exported to " + outPath, "info");
				return;
			}

			// Default: open interactive TUI dashboard
			// ── /agents alias (Claude-style muscle memory) ──────────────
			pi.registerCommand("agents", {
				description: "Alias for /threads — Claude-style Agent View dashboard",
				handler: async (a, c) => {
					// Forward to /threads
					await ctx.ui.custom<void>((tui, theme, _kb, done) => {
						const dashboard = createDashboard(
							registry,
							theme,
							() => done(),
							(id) => { registry.kill(id); ctx.ui.notify(`Killed ${id}`, "warning"); tui.requestRender(); },
							(id) => { const t = registry.get(id); if (t) { ctx.ui.notify(`Thread ${id}: ${t.tasks.map((tk) => `${tk.id}: ${tk.result?.slice(0,100) ?? tk.error ?? "(pending)"}`).join("\n")}`, "info"); } },
							(id, message) => { executor.injectReply(id, message); ctx.ui.notify(`Replied to ${id}: ${message.slice(0, 50)}...`, "info"); tui.requestRender(); },
							(id) => { const p = exportThread(id, registry, ctx.cwd); if (p) ctx.ui.notify(`Exported to ${p}`, "info"); }
						);
						return { render: (w: number) => dashboard.render(w), invalidate: () => dashboard.invalidate(), handleInput: (data: string) => { dashboard.handleInput(data); tui.requestRender(); } };
					});
				},
			});
			// ── End /agents alias ───────────────────────────────────────

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const dashboard = createDashboard(
					registry,
					theme,
					() => done(),
					(id) => {
						registry.kill(id);
						ctx.ui.notify(`Killed ${id}`, "warning");
						tui.requestRender();
					},
					(id) => {
						const t = registry.get(id);
						if (t) {
							const preview = t.tasks.map((tk) => `${tk.id}: ${tk.result?.slice(0, 100) ?? tk.error ?? "(pending)"}`).join("\n");
							ctx.ui.notify(`Thread ${id} results:\n${preview}`, "info");
						}
					},
					(id, message) => {
						// Inline reply — send message to blocked thread
						executor.injectReply(id, message);
						ctx.ui.notify(`Replied to ${id}: ${message.slice(0, 50)}...`, "info");
						tui.requestRender();
					},
					(id) => { const p = exportThread(id, registry, ctx.cwd); if (p) ctx.ui.notify(`Exported to ${p}`, "info"); }
				);

				return {
					render: (w: number) => dashboard.render(w),
					invalidate: () => dashboard.invalidate(),
					handleInput: (data: string) => { dashboard.handleInput(data); tui.requestRender(); },
				};
			});
		},
	});

	// ── /pthread — parallel via subagent ─────────────────────────

	pi.registerCommand("pthread", {
		description: 'P-Thread: run N tasks in parallel via subagent. Usage: /pthread "task 1" "task 2" "task 3"',
		handler: async (args, ctx) => {
			if (!args?.trim()) { ctx.ui.notify('Usage: /pthread "task 1" "task 2"', "error"); return; }
			const tasks = parseTaskArgs(args);
			if (tasks.length === 0) { ctx.ui.notify("No tasks specified", "error"); return; }

			const label = tasks.length === 1 ? tasks[0] : `${tasks.length} parallel tasks`;
			const thread = registry.create("parallel", label, tasks, { cwd: ctx.cwd, backend: "subagent" });

			ctx.ui.notify(`🧵 P-Thread ${thread.id}: Dispatching ${tasks.length} task(s) via subagent...`, "info");
			executor.dispatch(thread);
		},
	});

	// ── /cthread — chained via subagent ──────────────────────────

	pi.registerCommand("cthread", {
		description: 'C-Thread: sequential phases via subagent chain. Usage: /cthread "phase 1" "phase 2"',
		handler: async (args, ctx) => {
			if (!args?.trim()) { ctx.ui.notify('Usage: /cthread "phase 1" "phase 2"', "error"); return; }
			const phases = parseTaskArgs(args);
			if (phases.length < 2) { ctx.ui.notify("Need at least 2 phases", "error"); return; }

			const thread = registry.create("chained", `Chain: ${phases.length} phases`, phases, { cwd: ctx.cwd, backend: "subagent" });

			ctx.ui.notify(`🧵 C-Thread ${thread.id}: ${phases.length} phases via subagent chain...`, "info");
			executor.dispatch(thread);
		},
	});

	// ── /bthread — meta via subagent (scout→plan→build→review) ──

	pi.registerCommand("bthread", {
		description: "B-Thread: scout → plan → build → review via subagent. Usage: /bthread <goal>",
		handler: async (args, ctx) => {
			if (!args?.trim()) { ctx.ui.notify("Usage: /bthread <goal>", "error"); return; }

			const thread = registry.create("meta", `Meta: ${args.slice(0, 40)}`, [args.trim()], { cwd: ctx.cwd, backend: "subagent" });

			ctx.ui.notify(`🧵 B-Thread ${thread.id}: scout → plan → build → review...`, "info");
			executor.dispatch(thread);
		},
	});

	// ── /fthread — FUSION (native, multi-model) ──────────────────
	// This is unique to pi-threads — no other extension does this

	pi.registerCommand("fthread", {
		description: 'F-Thread: same prompt to N agents/models, compare results. Usage: /fthread "prompt" [--count N] [--models m1,m2,m3]',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('Usage: /fthread "prompt" [--count 3] [--models sonnet,gemini,gpt]', "error");
				return;
			}

			let count = 3;
			let models: string[] | undefined;
			let prompt = args;

			const countMatch = args.match(/--count\s+(\d+)/);
			if (countMatch) {
				count = parseInt(countMatch[1]);
				prompt = prompt.replace(countMatch[0], "").trim();
			}

			const modelsMatch = args.match(/--models\s+([\w/,.:@-]+)/);
			if (modelsMatch) {
				models = modelsMatch[1].split(",");
				count = models.length;
				prompt = prompt.replace(modelsMatch[0], "").trim();
			}

			prompt = prompt.replace(/^["']|["']$/g, "").trim();
			if (!prompt) { ctx.ui.notify("No prompt specified", "error"); return; }

			const prompts = Array(count).fill(prompt);
			const modelList = models ?? Array(count).fill(undefined);
			const thread = registry.create("fusion", `Fusion: ${prompt.slice(0, 40)}`, prompts, {
				models: modelList,
				cwd: ctx.cwd,
				backend: "native",
			});

			const modelDesc = models ? models.join(", ") : `${count} agents (same model)`;
			ctx.ui.notify(`🧵 F-Thread ${thread.id}: "${prompt.slice(0, 50)}" → ${modelDesc}`, "info");

			// Fusion runs natively — fire and forget
			executor.dispatch(thread).then(() => {
				if (thread.state === "completed") {
					ctx.ui.notify(`✅ F-Thread ${thread.id} done! ${count} results. Use /threads review`, "info");
				} else {
					ctx.ui.notify(`❌ F-Thread ${thread.id} ${thread.state}`, "error");
				}
			});
		},
	});

	// ── /zthread — ZERO-TOUCH (native + verification) ────────────
	// Unique to pi-threads — autonomous with verify gate

	pi.registerCommand("zthread", {
		description: 'Z-Thread: autonomous + verify. Usage: /zthread "prompt" --verify "npm test"',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('Usage: /zthread "prompt" --verify "npm test"', "error");
				return;
			}

			let prompt = args;
			let verifyCommand: string | undefined;

			const verifyMatch = args.match(/--verify\s+"([^"]+)"|--verify\s+'([^']+)'|--verify\s+(\S+)/);
			if (verifyMatch) {
				verifyCommand = verifyMatch[1] ?? verifyMatch[2] ?? verifyMatch[3];
				prompt = prompt.replace(verifyMatch[0], "").trim();
			}
			prompt = prompt.replace(/^["']|["']$/g, "").trim();

			const thread = registry.create("zero", `Zero: ${prompt.slice(0, 40)}`, [prompt], {
				cwd: ctx.cwd,
				backend: "native",
				verify: verifyCommand,
			});

			const verifyDesc = verifyCommand ? ` → verify: ${verifyCommand}` : "";
			ctx.ui.notify(`🧵 Z-Thread ${thread.id}: "${prompt.slice(0, 50)}"${verifyDesc}`, "info");

			executor.dispatch(thread).then(() => {
				if (thread.state === "completed") {
					ctx.ui.notify(`✅ Z-Thread ${thread.id} shipped!${verifyCommand ? " ✓ Verification passed." : ""}`, "info");
				} else {
					const err = thread.tasks[0]?.error ?? "unknown error";
					ctx.ui.notify(`❌ Z-Thread ${thread.id} failed: ${err.slice(0, 150)}`, "error");
				}
			});
		},
	});

	// ── /lthread — long-running (native) ─────────────────────────

	pi.registerCommand("lthread", {
		description: "L-Thread: extended autonomous run. Usage: /lthread <prompt>",
		handler: async (args, ctx) => {
			if (!args?.trim()) { ctx.ui.notify("Usage: /lthread <prompt>", "error"); return; }

			const thread = registry.create("long", `Long: ${args.slice(0, 40)}`, [args.trim()], {
				cwd: ctx.cwd,
				backend: "native",
			});

			ctx.ui.notify(`🧵 L-Thread ${thread.id}: Extended run starting...`, "info");

			executor.dispatch(thread).then(() => {
				if (thread.state === "completed") {
					ctx.ui.notify(`✅ L-Thread ${thread.id} done!`, "info");
				} else {
					ctx.ui.notify(`❌ L-Thread ${thread.id} ${thread.state}`, "error");
				}
			});
		},
	});

	// ── /wthread — worktree isolation (port from Grok CLI) ────

	pi.registerCommand("wthread", {
		description: 'W-Thread: run task in isolated git worktree. Usage: /wthread "task" or /wthread list or /wthread cleanup',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('Usage: /wthread "task" | /wthread list | /wthread cleanup', "error");
				return;
			}

			// Subcommands
			const parts = args.trim().split(/\s+/);
			const sub = parts[0].toLowerCase();

			if (sub === "list") {
				if (!isGitRepo(ctx.cwd)) { ctx.ui.notify("Not in a git repo", "error"); return; }
				const wts = listWorktrees(ctx.cwd);
				if (wts.length === 0) { ctx.ui.notify("No active worktrees", "info"); return; }
				const lines = wts.map((w) =>
					`  ${w.threadId} → ${w.branch} @ ${w.path} ${w.dirty ? "⚠ dirty" : ""} (↑${w.ahead} ↓${w.behind})`
				);
				ctx.ui.notify(`Worktrees (${wts.length}):\n${lines.join("\n")}`, "info");
				return;
			}

			if (sub === "cleanup") {
				if (!isGitRepo(ctx.cwd)) { ctx.ui.notify("Not in a git repo", "error"); return; }
				const result = cleanupAll(ctx.cwd);
				ctx.ui.notify(`Cleaned: ${result.removed} worktrees (${result.failed} failed)`, result.failed > 0 ? "warning" : "info");
				return;
			}

			if (sub === "push" && parts.length >= 2) {
				const threadId = parts[1];
				const msg = parts.slice(2).join(" ") || undefined;
				const ok = pushWorktreeChanges(ctx.cwd, threadId, msg);
				ctx.ui.notify(ok ? `Pushed ${threadId} changes` : "Push failed", ok ? "info" : "error");
				return;
			}

			// Default: create worktree and run task
			if (!isGitRepo(ctx.cwd)) { ctx.ui.notify("Not in a git repo — can't create worktree", "error"); return; }

			const task = args.trim();
			const thread = registry.create("worktree", `W: ${task.slice(0, 40)}`, [task], {
				cwd: ctx.cwd,
				backend: "native",
			});

			ctx.ui.notify(`🌳 W-Thread ${thread.id}: Creating worktree for "${task.slice(0, 50)}"...`, "info");

			executor.dispatch(thread).then(() => {
				if (thread.state === "completed") {
					ctx.ui.notify(`✅ W-Thread ${thread.id} done in worktree! Use /wthread push ${thread.id} to merge.`, "info");
				} else {
					ctx.ui.notify(`❌ W-Thread ${thread.id} ${thread.state}`, "error");
				}
			});
		},
	});

	// ── /plan — Plan mode (port from Grok CLI) ────────────────

	let planFile: string | null = null;
	let planApproved = false;

	pi.registerCommand("plan", {
		description: 'Plan mode: write, review, and approve a plan before execution. Usage: /plan "goal" | /plan approve | /plan reject | /plan status',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /plan <goal> | /plan approve | /plan reject | /plan status", "error");
				return;
			}

			const sub = args.trim().toLowerCase();

			if (sub === "approve") {
				if (!planFile) { ctx.ui.notify("No active plan. Use /plan \"goal\" first.", "error"); return; }
				planApproved = true;
				ctx.ui.notify("✅ Plan approved! You can now execute the planned work.", "info");
				return;
			}

			if (sub === "reject") {
				planFile = null;
				planApproved = false;
				ctx.ui.notify("✗ Plan rejected. Revise and re-submit with /plan \"goal\".", "warning");
				return;
			}

			if (sub === "status") {
				if (planFile && existsSync(planFile)) {
					const content = readFileSync(planFile, "utf8");
					const status = planApproved ? "✅ Approved" : "⏳ Awaiting approval";
					ctx.ui.notify(`Plan status: ${status}\n\n${content.slice(0, 1000)}`, "info");
				} else {
					ctx.ui.notify("No active plan.", "info");
				}
				return;
			}

			// Create a new plan
			const goal = args.trim();
			planApproved = false;

			// Create plan directory
			const planDir = join(ctx.cwd, ".pi", "plans");
			if (!existsSync(planDir)) mkdirSync(planDir, { recursive: true });
			const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
			planFile = join(planDir, `plan-${ts}.md`);

			const planMd = [
				`# Plan: ${goal}`,
				"",
				"## Goal",
				goal,
				"",
				"## Approach",
				"(Generated by agent — review and edit before approving)",
				"",
				"## Steps",
				"1. ",
				"2. ",
				"3. ",
				"",
				"## Verification",
				"- ",
				"",
				"---",
				`Created: ${new Date().toISOString()}`,
				"Status: draft (run `/plan approve` to approve, `/plan reject` to reject)",
			].join("\n");

			writeFileSync(planFile, planMd, "utf8");
			ctx.ui.notify(
				`📋 Plan created at ${planFile}\nReview it, then run /plan approve or /plan reject.`,
				"info"
			);
		},
	});

	// ── /loop — Scheduled recurring tasks (port from Grok CLI) ─

	const scheduler = new Map<string, { interval: number; prompt: string; timer: ReturnType<typeof setInterval> | null }>();

	function parseInterval(input: string): number | null {
		const m = input.match(/^(\d+)(s|m|h|d)$/);
		if (!m) return null;
		const n = parseInt(m[1]);
		switch (m[2]) {
			case "s": return n * 1000;
			case "m": return n * 60 * 1000;
			case "h": return n * 3600 * 1000;
			case "d": return n * 86400 * 1000;
			default: return null;
		}
	}

	pi.registerCommand("loop", {
		description: 'Schedule a recurring task. Usage: /loop 5m "check test status" | /loop list | /loop stop <id>',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /loop <interval> <prompt> | /loop list | /loop stop <id>", "error");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const sub = parts[0].toLowerCase();

			if (sub === "list") {
				if (scheduler.size === 0) { ctx.ui.notify("No scheduled tasks.", "info"); return; }
				const lines: string[] = [];
				for (const [id, task] of scheduler) {
					const intervalStr = `${task.interval / 1000}s`;
					lines.push(`  ${id}: every ${intervalStr} — "${task.prompt.slice(0, 50)}"`);
				}
				ctx.ui.notify(`Scheduled tasks (${scheduler.size}):\n${lines.join("\n")}`, "info");
				return;
			}

			if (sub === "stop" && parts.length >= 2) {
				const id = parts[1];
				const task = scheduler.get(id);
				if (!task) { ctx.ui.notify(`No scheduled task with id ${id}`, "error"); return; }
				if (task.timer) clearInterval(task.timer);
				scheduler.delete(id);
				ctx.ui.notify(`Stopped ${id}`, "info");
				return;
			}

			// Parse: /loop 5m "prompt"
			const intervalStr = parts[0];
			const interval = parseInterval(intervalStr);
			if (!interval) { ctx.ui.notify(`Invalid interval: ${intervalStr}. Use format: 30s, 5m, 2h, 1d`, "error"); return; }

			const prompt = parts.slice(1).join(" ");
			if (!prompt) { ctx.ui.notify("No prompt specified", "error"); return; }

			const id = `loop-${Date.now()}`;
			ctx.ui.notify(`⏰ /loop ${id}: every ${intervalStr} — "${prompt.slice(0, 50)}"`, "info");

			// Fire immediately
			const thread = registry.create("scheduled", `Loop: ${prompt.slice(0, 40)}`, [prompt], {
				cwd: ctx.cwd,
				backend: "native",
			});
			executor.dispatch(thread);

			// Schedule recurring
			const timer = setInterval(() => {
				const t = registry.create("scheduled", `Loop: ${prompt.slice(0, 40)}`, [prompt], {
					cwd: ctx.cwd,
					backend: "native",
				});
				executor.dispatch(t);
			}, interval);

			scheduler.set(id, { interval, prompt, timer });
		},
	});

	// ── /story — STORIES (the unique layer) ──────────────────────

	pi.registerCommand("story", {
		description: 'Story mode: auto-decompose goal into thread phases. Usage: /story "Add dark mode" [--verify "npm test"]',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('Usage: /story "goal" [--verify "npm test"]', "error");
				return;
			}

			// Parse verify flag
			let goal = args;
			let verify: string | undefined;
			const verifyMatch = args.match(/--verify\s+"([^"]+)"|--verify\s+'([^']+)'|--verify\s+(\S+)/);
			if (verifyMatch) {
				verify = verifyMatch[1] ?? verifyMatch[2] ?? verifyMatch[3];
				goal = goal.replace(verifyMatch[0], "").trim();
			}
			goal = goal.replace(/^["']|["']$/g, "").trim();

			const story = registry.createStory(goal, verify);

			// Auto-decompose into phases
			const phases: StoryPhase[] = [
				{ name: "scout", threadType: "meta", state: "pending", description: `Research: ${goal}` },
				{ name: "plan", threadType: "fusion", state: "pending", description: `3 models brainstorm approaches for: ${goal}` },
				{ name: "decide", threadType: "chained", state: "pending", description: "Human picks the best approach" },
				{ name: "build", threadType: "parallel", state: "pending", description: `Implement: ${goal}` },
			];

			if (verify) {
				phases.push({ name: "verify", threadType: "zero", state: "pending", description: `Verify: ${verify}` });
			}

			for (const p of phases) {
				registry.addPhase(story.id, p);
			}

			const phaseNames = phases.map((p) => p.name).join(" → ");
			ctx.ui.notify(`📖 Story ${story.id}: "${goal.slice(0, 50)}"\n   Phases: ${phaseNames}`, "info");

			// Start with the scout phase — send it to the LLM to execute
			registry.startPhase(story.id, 0, "pending");

			// The story orchestration happens via the LLM — we give it the plan
			const storyPrompt = [
				`## Story ${story.id}: ${goal}`,
				"",
				"Execute this story phase by phase. Use the thread tools.",
				"",
				"### Phases:",
				...phases.map((p, i) => `${i + 1}. **${p.name}** (${p.threadType}): ${p.description}`),
				"",
				"### Instructions:",
				"1. Start with phase 1 (scout) — use `thread_spawn` with type 'meta'",
				"2. For phase 2 (plan), use `thread_spawn` with type 'fusion' and --models if available",
				"3. Present the fusion results to the user for phase 3 (decide)",
				"4. Execute phase 4 (build) based on the chosen approach",
				verify ? `5. Run verification: \`${verify}\`` : "",
				"",
				"Check progress with `thread_status`. Report when done.",
			].filter(Boolean).join("\n");

			pi.sendUserMessage(storyPrompt, { deliverAs: "followUp" });
		},
	});

	// ── /stories — list stories ──────────────────────────────────

	pi.registerCommand("stories", {
		description: "List all stories",
		handler: async (_args, ctx) => {
			const stories = registry.allStories();
			if (stories.length === 0) {
				ctx.ui.notify("No stories. Use /story to start one.", "info");
				return;
			}

			const lines: string[] = ["📖 Stories", ""];
			for (const s of stories) {
				const phases = s.phases.map((p) => `${stateIcon(p.state)}${p.name}`).join(" → ");
				lines.push(`  ${s.id} [${s.state}] ${s.goal.slice(0, 60)}`);
				lines.push(`    ${phases}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── LLM-callable tools ───────────────────────────────────────

	pi.registerTool({
		name: "thread_spawn",
		label: "Thread Spawn",
		description: [
			"Spawn a thread. Types:",
			"- parallel: N independent tasks in parallel (via subagent)",
			"- chained: sequential phases with checkpoints (via subagent)",
			"- meta: scout→plan→build→review pipeline (via subagent)",
			"- fusion: same prompt to N agents/models, compare results (native, UNIQUE)",
			"- zero: autonomous + verification command gate (native, UNIQUE)",
			"- long: extended autonomous run (native)",
			"- worktree: run in isolated git worktree (native, port from Grok CLI)",
			"- plan: structured plan→approve→execute gate (native, port from Grok CLI)",
			"- scheduled: recurring scheduled task (native, port from Grok CLI)",
		].join("\n"),
		parameters: Type.Object({
			type: StringEnum(["parallel", "fusion", "chained", "meta", "long", "zero", "worktree", "plan", "scheduled"] as const),
			prompts: Type.Array(Type.String(), { description: "Task prompts" }),
			models: Type.Optional(Type.Array(Type.String(), { description: "Models for fusion (e.g. ['anthropic/claude-sonnet-4', 'google/gemini-2.5-pro'])" })),
			count: Type.Optional(Type.Number({ description: "Agent count for fusion (default 3)" })),
			verify: Type.Optional(Type.String({ description: "Verification command for zero-touch (e.g. 'npm test')" })),
			agent: Type.Optional(Type.String({ description: "Subagent agent name (default: worker)" })),
			backend: Type.Optional(StringEnum(["subagent", "native"] as const)),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { type, prompts, models, count, verify, agent, backend: backendOverride } = params;
			let taskPrompts = prompts;

			if (type === "fusion") {
				const n = count ?? models?.length ?? 3;
				taskPrompts = Array(n).fill(prompts[0]);
			}

			if (type === "meta" && prompts.length === 1) {
				taskPrompts = [prompts[0]]; // Meta delegates to subagent chain internally
			}

			// Auto-select backend
			const backend = backendOverride ?? (type === "fusion" || type === "zero" || type === "long" ? "native" : "subagent");

			const label = type === "fusion"
				? `Fusion: ${prompts[0]?.slice(0, 40)}`
				: `${type}: ${taskPrompts.length} tasks`;

			const thread = registry.create(type as ThreadType, label, taskPrompts, {
				models,
				cwd: ctx.cwd,
				backend,
				agent,
				verify,
			});

			// Dispatch (async — runs in background)
			executor.dispatch(thread);

			const modelInfo = models ? ` Models: ${models.join(", ")}` : "";
			const verifyInfo = verify ? ` Verify: ${verify}` : "";
			const backendInfo = backend === "subagent" ? " (via pi-subagents)" : " (native pi -p)";

			return {
				content: [{
					type: "text",
					text: `Thread ${thread.id} (${type}) spawned.${backendInfo}${modelInfo}${verifyInfo}\n${taskPrompts.length} task(s). Use /threads or thread_status to monitor.`,
				}],
				details: { threadId: thread.id, type, taskCount: taskPrompts.length, backend },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("thread_spawn ")) +
					theme.fg("accent", args.type) +
					theme.fg("muted", ` (${args.prompts?.length ?? "?"} tasks)`),
				0, 0
			);
		},
	});

	pi.registerTool({
		name: "thread_status",
		label: "Thread Status",
		description: "Get status of all threads and stories, or a specific thread/story by ID",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Thread ID (t-001) or Story ID (s-001). Omit for all." })),
		}),
		async execute(_toolCallId, params, _signal?: any, _onUpdate?: any, _ctx?: any) {
			if (params.id) {
				// Check threads first
				const t = registry.get(params.id);
				if (t) {
					const sum = registry.summarize(t);
					const taskDetails = t.tasks
						.map((tk) => {
							let line = `  ${stateIcon(tk.state)} ${tk.id} [${tk.state}] ${tk.label}`;
							if (tk.model) line += ` [${tk.model}]`;
							if (tk.result) line += `\n    ${tk.result.slice(0, 300)}`;
							if (tk.error) line += `\n    ERROR: ${tk.error.slice(0, 200)}`;
							return line;
						})
						.join("\n");
					return {
						content: [{
							type: "text",
							text: `Thread ${sum.id} (${sum.type}) [${sum.backend}] — ${sum.state} — ${sum.progress} — ${sum.elapsed}\n${taskDetails}`,
						}],
					};
				}

				// Check stories
				const s = registry.getStory(params.id);
				if (s) {
					const phases = s.phases
						.map((p) => `  ${stateIcon(p.state)} ${p.name} (${p.threadType}): ${p.description}${p.threadId ? ` [${p.threadId}]` : ""}`)
						.join("\n");
					return {
						content: [{
							type: "text",
							text: `Story ${s.id} [${s.state}] — ${s.goal}\n${phases}`,
						}],
					};
				}

				return { content: [{ type: "text", text: `ID ${params.id} not found` }], isError: true } as any;
			}

			// All
			const lines: string[] = [];
			const stories = registry.allStories();
			const threads = registry.all();

			if (stories.length > 0) {
				lines.push("📖 Stories:");
				for (const s of stories) {
					const phases = s.phases.map((p) => `${stateIcon(p.state)}${p.name}`).join("→");
					lines.push(`  ${s.id} [${s.state}] ${s.goal.slice(0, 50)} — ${phases}`);
				}
			}

			if (threads.length > 0) {
				lines.push("🧵 Threads:");
				for (const t of threads) {
					const s = registry.summarize(t);
					lines.push(`  ${s.id} ${typeIcon(s.type)} ${s.type} [${s.state}] ${s.progress} (${s.elapsed}) [${s.backend}] — ${s.label}`);
				}
			}

			if (lines.length === 0) {
				return { content: [{ type: "text", text: "No threads or stories." }] } as any;
			}

			return { content: [{ type: "text", text: lines.join("\n") }] } as any;
		},
	});

	pi.registerTool({
		name: "thread_kill",
		label: "Thread Kill",
		description: "Kill a running thread by ID",
		parameters: Type.Object({
			id: Type.String({ description: "Thread ID to kill" }),
		}),
		async execute(_toolCallId, params, _signal?: any, _onUpdate?: any, _ctx?: any) {
			const t = registry.get(params.id);
			if (!t) return { content: [{ type: "text", text: `Thread ${params.id} not found` }], isError: true };
			registry.kill(params.id);
			return { content: [{ type: "text", text: `Thread ${params.id} killed.` }] } as any;
		},
	});
}
