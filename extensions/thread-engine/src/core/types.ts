/** Thread types from the thread engineering framework */
export type ThreadType = "base" | "parallel" | "chained" | "fusion" | "meta" | "long" | "zero" | "worktree" | "plan" | "scheduled" | "monitor";

/** Thread lifecycle states */
export type ThreadState = "pending" | "running" | "paused" | "completed" | "failed" | "killed" | "needs_input";

/** How a thread is executed */
export type ExecutionBackend = "subagent" | "native";

/** A single unit of work within a thread */
export interface ThreadTask {
	usage?: { inputTokens: number; outputTokens: number; cacheRead: number; totalTokens: number; cost: number };
	id: string;
	label: string;
	prompt: string;
	model?: string;
	state: ThreadState;
	startedAt?: number;
	completedAt?: number;
	result?: string;
	error?: string;
	/** interactive_shell session ID or subagent run ID */
	sessionId?: string;
}

/** Thread configuration */
export interface ThreadConfig {
	type: ThreadType;
	tasks: ThreadTask[];
	/** Execution backend */
	backend: ExecutionBackend;
	/** For fusion threads: models to compete */
	models?: string[];
	/** For zero threads: verification command */
	verifyCommand?: string;
	/** For chained threads: require human checkpoint between phases */
	checkpoints?: boolean;
	/** Working directory */
	cwd?: string;
	/** Subagent agent name to use (default: "worker") */
	agent?: string;
}

/** A thread — the fundamental unit of tracked work */
export interface Thread {
	id: string;
	type: ThreadType;
	label: string;
	state: ThreadState;
	config: ThreadConfig;
	tasks: ThreadTask[];
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	/** Duration in ms */
	duration?: number;
}

/** A story — a goal decomposed into thread phases */
export interface Story {
	id: string;
	goal: string;
	state: "planning" | "executing" | "verifying" | "done" | "failed";
	phases: StoryPhase[];
	createdAt: number;
	completedAt?: number;
	/** Verification command */
	verify?: string;
	/** Files changed */
	artifacts: string[];
}

export interface StoryPhase {
	name: string;
	threadType: ThreadType;
	threadId?: string;
	state: ThreadState;
	description: string;
}

/** Short status line for dashboard */
export interface ThreadSummary {
	id: string;
	type: ThreadType;
	label: string;
	state: ThreadState;
	progress: string;
	elapsed: string;
	totalTokens: number;
	totalCost: number;
	backend: ExecutionBackend;
}

/** Thread event for state changes */
export type ThreadEvent =
	| { type: "thread_created"; thread: Thread }
	| { type: "thread_started"; thread: Thread }
	| { type: "task_started"; thread: Thread; task: ThreadTask }
	| { type: "task_completed"; thread: Thread; task: ThreadTask }
	| { type: "task_failed"; thread: Thread; task: ThreadTask }
	| { type: "thread_completed"; thread: Thread }
	| { type: "thread_failed"; thread: Thread }
	| { type: "thread_killed"; thread: Thread }
	| { type: "story_created"; story: Story }
	| { type: "story_phase_started"; story: Story; phase: StoryPhase }
	| { type: "story_completed"; story: Story }
	| { type: "story_failed"; story: Story };
