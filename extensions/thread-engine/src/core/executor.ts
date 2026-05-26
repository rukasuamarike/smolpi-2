import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ThreadRegistry } from "./registry.js";
import type { Thread, ThreadTask } from "./types.js";

/**
 * Executor — runs thread tasks.
 *
 * Two backends:
 * - "subagent": delegates to pi-subagents via sendUserMessage (inherits agent specialization, TUI, artifacts)
 * - "native": spawns pi -p directly (for fusion/zero where we need raw control)
 */
export class ThreadExecutor {
	constructor(
		private pi: ExtensionAPI,
		private registry: ThreadRegistry
	) {}

	// ── Native execution (pi -p) ────────────────────────────────

	private async runTaskNative(thread: Thread, task: ThreadTask): Promise<void> {
		const cwd = thread.config.cwd ?? process.cwd();
		this.registry.startTask(thread.id, task.id);

		try {
			const args = ["-p", task.prompt];
			if (task.model) args.unshift("-m", task.model);

			const result = await this.pi.exec("pi", args, {
				cwd,
				timeout: 10 * 60 * 1000,
			});

			if (result.code === 0) {
				this.registry.completeTask(thread.id, task.id, result.stdout);
			// Parse --mode json output for token/cost data
			try {
				const jsonLines = result.stdout.split("\n").filter(l => l.startsWith("{\"type\":\"message_end\"}"));
				const last = jsonLines[jsonLines.length - 1];
				if (last) {
					const msg = JSON.parse(last);
					if (msg.message?.usage) {
						const u = msg.message.usage;
						task.usage = {
							inputTokens: u.input ?? 0,
							outputTokens: u.output ?? 0,
							totalTokens: u.totalTokens ?? 0,
							cacheRead: u.cacheRead ?? 0,
							cost: (u.cost?.input ?? 0) + (u.cost?.output ?? 0),
						};
					}
				}
			} catch {}
			} else {
				this.registry.failTask(thread.id, task.id, result.stderr || `Exit code: ${result.code}`);
			}
		} catch (err: any) {
			this.registry.failTask(thread.id, task.id, err.message ?? String(err));
		}
	}

	// ── Subagent execution (via sendUserMessage) ────────────────

	private launchSubagentParallel(thread: Thread): void {
		const agent = thread.config.agent ?? "worker";
		const tasks = thread.tasks.map((t) => ({
			agent,
			task: t.prompt,
			...(t.model ? { model: t.model } : {}),
		}));

		// Send as a user message that pi-subagents will pick up
		this.pi.sendUserMessage(
			`Run these tasks in parallel using subagent:\n\`\`\`json\n${JSON.stringify({ tasks }, null, 2)}\n\`\`\``,
			{ deliverAs: "followUp" }
		);

		// Mark all tasks as running (subagent handles the rest)
		this.registry.startThread(thread.id);
		for (const task of thread.tasks) {
			this.registry.startTask(thread.id, task.id);
		}
	}

	private launchSubagentChain(thread: Thread): void {
		const agent = thread.config.agent ?? "worker";
		const chain = thread.tasks.map((t, i) => ({
			agent,
			task: i === 0 ? t.prompt : `Continue: ${t.prompt}. Previous context: {previous}`,
			...(t.model ? { model: t.model } : {}),
		}));

		this.pi.sendUserMessage(
			`Run this chain using subagent:\n\`\`\`json\n${JSON.stringify({ chain }, null, 2)}\n\`\`\``,
			{ deliverAs: "followUp" }
		);

		this.registry.startThread(thread.id);
		this.registry.startTask(thread.id, thread.tasks[0].id);
	}

	private launchSubagentMeta(thread: Thread): void {
		const chain = [
			{ agent: "scout", task: thread.tasks[0]?.prompt ?? "Scout the codebase" },
			{ agent: "planner", task: "{previous}" },
			{ agent: "worker", task: "{previous}" },
			{ agent: "reviewer", task: "{previous}" },
		];

		this.pi.sendUserMessage(
			`Run this meta pipeline using subagent:\n\`\`\`json\n${JSON.stringify({ chain }, null, 2)}\n\`\`\``,
			{ deliverAs: "followUp" }
		);

		this.registry.startThread(thread.id);
		this.registry.startTask(thread.id, thread.tasks[0].id);
	}

	// ── Fusion (native, multi-model) ────────────────────────────

	async execFusion(thread: Thread): Promise<void> {
		this.registry.startThread(thread.id);
		// All tasks run in parallel with potentially different models
		await Promise.allSettled(thread.tasks.map((task) => this.runTaskNative(thread, task)));
	}

	// ── Zero-touch (native + verification) ──────────────────────

	async execZero(thread: Thread): Promise<void> {
		this.registry.startThread(thread.id);
		const task = thread.tasks[0];
		await this.runTaskNative(thread, task);

		// If task succeeded and we have a verify command, run it
		if (task.state === "completed" && thread.config.verifyCommand) {
			const cwd = thread.config.cwd ?? process.cwd();
			try {
				const verify = await this.pi.exec("bash", ["-c", thread.config.verifyCommand], {
					cwd,
					timeout: 5 * 60 * 1000,
				});
				if (verify.code !== 0) {
					// Override the completed state to failed
					task.state = "failed";
					task.error = `Verification failed (${thread.config.verifyCommand}): ${verify.stderr || verify.stdout}`;
					thread.state = "failed";
					thread.completedAt = Date.now();
					thread.duration = thread.completedAt - (thread.startedAt ?? thread.createdAt);
				}
			} catch (err: any) {
				task.state = "failed";
				task.error = `Verification error: ${err.message}`;
				thread.state = "failed";
				thread.completedAt = Date.now();
			}
		}
	}

	// ── Dispatch ─────────────────────────────────────────────────

	async dispatch(
		thread: Thread,
		opts?: { onCheckpoint?: (phase: number, task: ThreadTask) => Promise<boolean> }
	): Promise<void> {
		const backend = thread.config.backend;

		if (backend === "subagent") {
			switch (thread.type) {
				case "parallel":
					return this.launchSubagentParallel(thread);
				case "chained":
					return this.launchSubagentChain(thread);
				case "meta":
					return this.launchSubagentMeta(thread);
				default:
					// Fall through to native for unsupported subagent types
					break;
			}
		}

		// Native execution
		switch (thread.type) {
			case "base":
			case "long":
			case "plan":
			case "scheduled":
				this.registry.startThread(thread.id);
				return this.runTaskNative(thread, thread.tasks[0]);
			case "parallel":
				this.registry.startThread(thread.id);
				await Promise.allSettled(thread.tasks.map((t) => this.runTaskNative(thread, t)));
				return;
			case "fusion":
				return this.execFusion(thread);
			case "zero":
				return this.execZero(thread);
			case "worktree":
				return this.execWorktree(thread);
			case "chained": {
				this.registry.startThread(thread.id);
				for (let i = 0; i < thread.tasks.length; i++) {
					if (i > 0 && opts?.onCheckpoint) {
						const proceed = await opts.onCheckpoint(i, thread.tasks[i]);
						if (!proceed) {
							this.registry.kill(thread.id);
							return;
						}
					}
					await this.runTaskNative(thread, thread.tasks[i]);
					if (thread.tasks[i].state === "failed") return;
				}
				return;
			}
			case "meta":
				this.registry.startThread(thread.id);
				for (const task of thread.tasks) {
					await this.runTaskNative(thread, task);
					if (task.state === "failed") return;
				}
				return;
		}
	}

	/** Execute a thread in an isolated git worktree */
	private async execWorktree(thread: Thread): Promise<void> {
		const cwd = thread.config.cwd ?? process.cwd();
		this.registry.startThread(thread.id);

		try {
			const { createWorktree, removeWorktree, findRepoRoot, pushWorktreeChanges } = await import("./worktree.js");
			const repoPath = findRepoRoot(cwd);

			if (!repoPath) {
				this.registry.failTask(thread.id, thread.tasks[0].id, "Not in a git repository");
				return;
			}

			// Create worktree
			const wt = createWorktree(cwd, thread.id);
			const task = thread.tasks[0];

			// Write task prompt to worktree
			const { writeFileSync } = await import("fs");
			const { join } = await import("path");
			writeFileSync(join(wt.path, ".pi-thread-task.md"), task.prompt, "utf8");

			// Run the task inside the worktree using pi -p
			try {
				const result = await this.pi.exec("pi", ["-p", task.prompt], {
					cwd: wt.path,
					timeout: 30 * 60 * 1000, // 30 min max
				});

				if (result.code === 0) {
					// Write result marker
					writeFileSync(join(wt.path, ".pi-thread-result.json"), JSON.stringify({
						threadId: thread.id,
						status: "completed",
						output: result.stdout,
						timestamp: Date.now(),
					}, null, 2), "utf8");

					this.registry.completeTask(thread.id, task.id, result.stdout);
				} else {
					this.registry.failTask(thread.id, task.id, result.stderr || `Exit code: ${result.code}`);
				}
			} catch (err: any) {
				this.registry.failTask(thread.id, task.id, err.message ?? String(err));
			}

			// Always clean up worktree after execution
			removeWorktree(cwd, thread.id);
		} catch (err: any) {
			this.registry.failTask(thread.id, thread.tasks[0].id, err.message ?? String(err));
		}
	}

	/** Inject a reply into a running thread — sends message to its session */
	injectReply(threadId: string, message: string): void {
		const thread = this.registry.get(threadId);
		if (!thread) return;

		// Mark the blocked task as no longer needing input
		for (const task of thread.tasks) {
			if (task.state === "needs_input") {
				task.state = "running";
			}
		}

		// Forward the reply to the running subagent session via sendUserMessage
		// The subagent will pick up the new context and continue
		this.pi.sendUserMessage(
			`[Thread ${threadId}] Reply to blocked thread: ${message}`,
			{ deliverAs: "followUp" }
		);
	}
}
