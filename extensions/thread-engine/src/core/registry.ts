import type { ExecutionBackend, Story, StoryPhase, Thread, ThreadEvent, ThreadState, ThreadSummary, ThreadTask, ThreadType } from "./types.js";

type EventHandler = (event: ThreadEvent) => void;

let nextThreadId = 1;
let nextStoryId = 1;

function genThreadId(): string {
	return `t-${String(nextThreadId++).padStart(3, "0")}`;
}

function genStoryId(): string {
	return `s-${String(nextStoryId++).padStart(3, "0")}`;
}

function genTaskId(threadId: string, index: number): string {
	return `${threadId}.${index + 1}`;
}

/** Format elapsed time */
export function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return `${m}m ${rem}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

/** Central registry for all threads and stories */
export class ThreadRegistry {
	private threads = new Map<string, Thread>();
	private stories = new Map<string, Story>();
	private handlers: EventHandler[] = [];

	on(handler: EventHandler): () => void {
		this.handlers.push(handler);
		return () => {
			const idx = this.handlers.indexOf(handler);
			if (idx >= 0) this.handlers.splice(idx, 1);
		};
	}

	private emit(event: ThreadEvent) {
		for (const h of this.handlers) {
			try {
				h(event);
			} catch (e) {
				console.error("[pi-threads] event handler error:", e);
			}
		}
	}

	// ── Threads ──────────────────────────────────────────────────

	create(
		type: ThreadType,
		label: string,
		prompts: string[],
		opts?: { models?: string[]; cwd?: string; backend?: ExecutionBackend; agent?: string; verify?: string }
	): Thread {
		const threadId = genThreadId();
		const tasks: ThreadTask[] = prompts.map((prompt, i) => ({
			id: genTaskId(threadId, i),
			label: prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt,
			prompt,
			model: opts?.models?.[i],
			state: "pending" as ThreadState,
		}));

		const thread: Thread = {
			id: threadId,
			type,
			label,
			state: "pending",
			config: {
				type,
				tasks,
				backend: opts?.backend ?? "native",
				cwd: opts?.cwd,
				models: opts?.models,
				agent: opts?.agent,
				verifyCommand: opts?.verify,
			},
			tasks,
			createdAt: Date.now(),
		};

		this.threads.set(threadId, thread);
		this.emit({ type: "thread_created", thread });
		return thread;
	}

	get(id: string): Thread | undefined {
		return this.threads.get(id);
	}

	all(): Thread[] {
		return [...this.threads.values()];
	}

	byState(state: ThreadState): Thread[] {
		return this.all().filter((t) => t.state === state);
	}

	startThread(id: string) {
		const t = this.threads.get(id);
		if (!t) return;
		t.state = "running";
		t.startedAt = Date.now();
		this.emit({ type: "thread_started", thread: t });
	}

	startTask(threadId: string, taskId: string, sessionId?: string) {
		const t = this.threads.get(threadId);
		if (!t) return;
		const task = t.tasks.find((tk) => tk.id === taskId);
		if (!task) return;
		task.state = "running";
		task.startedAt = Date.now();
		if (sessionId) task.sessionId = sessionId;
		this.emit({ type: "task_started", thread: t, task });
	}

	completeTask(threadId: string, taskId: string, result?: string) {
		const t = this.threads.get(threadId);
		if (!t) return;
		const task = t.tasks.find((tk) => tk.id === taskId);
		if (!task) return;
		task.state = "completed";
		task.completedAt = Date.now();
		if (result) task.result = result;
		this.emit({ type: "task_completed", thread: t, task });

		if (t.tasks.every((tk) => tk.state === "completed")) {
			t.state = "completed";
			t.completedAt = Date.now();
			t.duration = t.completedAt - (t.startedAt ?? t.createdAt);
			this.emit({ type: "thread_completed", thread: t });
		}
	}

	failTask(threadId: string, taskId: string, error: string) {
		const t = this.threads.get(threadId);
		if (!t) return;
		const task = t.tasks.find((tk) => tk.id === taskId);
		if (!task) return;
		task.state = "failed";
		task.completedAt = Date.now();
		task.error = error;
		this.emit({ type: "task_failed", thread: t, task });

		// For parallel/fusion: don't fail the whole thread if one task fails
		if (t.type === "parallel" || t.type === "fusion") {
			const allDone = t.tasks.every((tk) => tk.state === "completed" || tk.state === "failed");
			if (allDone) {
				const anySuccess = t.tasks.some((tk) => tk.state === "completed");
				t.state = anySuccess ? "completed" : "failed";
				t.completedAt = Date.now();
				t.duration = t.completedAt - (t.startedAt ?? t.createdAt);
				this.emit(anySuccess ? { type: "thread_completed", thread: t } : { type: "thread_failed", thread: t });
			}
		} else {
			t.state = "failed";
			t.completedAt = Date.now();
			t.duration = t.completedAt - (t.startedAt ?? t.createdAt);
			this.emit({ type: "thread_failed", thread: t });
		}
	}

	kill(id: string) {
		const t = this.threads.get(id);
		if (!t) return;
		t.state = "killed";
		t.completedAt = Date.now();
		t.duration = t.completedAt - (t.startedAt ?? t.createdAt);
		for (const task of t.tasks) {
			if (task.state === "running" || task.state === "pending") {
				task.state = "killed";
				task.completedAt = Date.now();
			}
		}
		this.emit({ type: "thread_killed", thread: t });
	}

	summarize(thread: Thread): ThreadSummary {
		const done = thread.tasks.filter((t) => t.state === "completed").length;
		const failed = thread.tasks.filter((t) => t.state === "failed").length;
		const total = thread.tasks.length;
		const elapsed = thread.startedAt ? formatElapsed(Date.now() - thread.startedAt) : "-";
		const progress = failed > 0 ? `${done}/${total} (${failed}✗)` : `${done}/${total}`;

		return {
			id: thread.id,
			type: thread.type,
			label: thread.label,
			state: thread.state,
			progress,
			elapsed,
		totalTokens: thread.tasks.reduce((a, tk) => a + (tk.usage?.totalTokens ?? 0), 0),
		totalCost: thread.tasks.reduce((a, tk) => a + (tk.usage?.cost ?? 0), 0),
			backend: thread.config.backend,
		};
	}

	prune() {
		for (const [id, t] of this.threads) {
			if (t.state === "completed" || t.state === "failed" || t.state === "killed") {
				this.threads.delete(id);
			}
		}
	}

	/** Restore state from session persistence */
	restore(threads: Thread[], stories: Story[]) {
		for (const t of threads) {
			this.threads.set(t.id, t);
			// Advance ID counter past restored IDs to avoid collisions
			const num = parseInt(t.id.replace("t-", ""), 10);
			if (!isNaN(num) && num >= nextThreadId) nextThreadId = num + 1;
		}
		for (const s of stories) {
			this.stories.set(s.id, s);
			const num = parseInt(s.id.replace("s-", ""), 10);
			if (!isNaN(num) && num >= nextStoryId) nextStoryId = num + 1;
		}
	}

	// ── Stories ──────────────────────────────────────────────────

	createStory(goal: string, verify?: string): Story {
		const story: Story = {
			id: genStoryId(),
			goal,
			state: "planning",
			phases: [],
			createdAt: Date.now(),
			verify,
			artifacts: [],
		};
		this.stories.set(story.id, story);
		this.emit({ type: "story_created", story });
		return story;
	}

	getStory(id: string): Story | undefined {
		return this.stories.get(id);
	}

	allStories(): Story[] {
		return [...this.stories.values()];
	}

	addPhase(storyId: string, phase: StoryPhase) {
		const s = this.stories.get(storyId);
		if (!s) return;
		s.phases.push(phase);
	}

	startPhase(storyId: string, phaseIndex: number, threadId: string) {
		const s = this.stories.get(storyId);
		if (!s || !s.phases[phaseIndex]) return;
		s.phases[phaseIndex].state = "running";
		s.phases[phaseIndex].threadId = threadId;
		s.state = "executing";
		this.emit({ type: "story_phase_started", story: s, phase: s.phases[phaseIndex] });
	}

	completePhase(storyId: string, phaseIndex: number) {
		const s = this.stories.get(storyId);
		if (!s || !s.phases[phaseIndex]) return;
		s.phases[phaseIndex].state = "completed";

		if (s.phases.every((p) => p.state === "completed")) {
			s.state = "done";
			s.completedAt = Date.now();
			this.emit({ type: "story_completed", story: s });
		}
	}

	failStory(storyId: string) {
		const s = this.stories.get(storyId);
		if (!s) return;
		s.state = "failed";
		s.completedAt = Date.now();
		this.emit({ type: "story_failed", story: s });
	}
}
