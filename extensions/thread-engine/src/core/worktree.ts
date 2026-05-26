/**
 * Worktree management for pi-thread-engine
 *
 * Mirrors Grok CLI's `isolation: "worktree"` pattern.
 * Each worktree gets its own branch + working directory so parallel
 * agents never conflict on file edits.
 *
 * Worktrees stored under `<repo>/.git/worktrees-pi/` for easy cleanup.
 */

import { execSync, exec } from "child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export interface WorktreeInfo {
	path: string;
	branch: string;
	threadId: string;
	createdAt: number;
	ahead: number;
	behind: number;
	dirty: boolean;
}

const WORKTREE_DIR = ".git/worktrees-pi";
let worktreeRegistry: WorktreeInfo[] = [];

function loadRegistry(repoPath: string): WorktreeInfo[] {
	const regPath = join(repoPath, WORKTREE_DIR, "registry.json");
	if (existsSync(regPath)) {
		try {
			return JSON.parse(readFileSync(regPath, "utf8"));
		} catch { /* corrupt, start fresh */ }
	}
	return [];
}

function saveRegistry(repoPath: string, reg: WorktreeInfo[]) {
	const regDir = join(repoPath, WORKTREE_DIR);
	if (!existsSync(regDir)) mkdirSync(regDir, { recursive: true });
	writeFileSync(join(regDir, "registry.json"), JSON.stringify(reg, null, 2), "utf8");
}

/** Resolve the git repo root from a path */
export function findRepoRoot(cwd: string): string | null {
	try {
		return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return null;
	}
}

/** Check if we're in a git repo */
export function isGitRepo(cwd: string): boolean {
	return findRepoRoot(cwd) !== null;
}

/** Generate a unique branch name for a thread */
export function branchName(threadId: string): string {
	const safe = threadId.replace(/[^a-zA-Z0-9-]/g, "-");
	return `pi-thread/${safe}`;
}

/** Worktree storage path for a thread */
export function worktreePath(repoPath: string, threadId: string): string {
	return join(repoPath, WORKTREE_DIR, threadId);
}

/**
 * Create a worktree for a thread.
 * Creates a new branch off the current HEAD, checks it out in an isolated dir.
 */
export function createWorktree(cwd: string, threadId: string, baseBranch?: string): WorktreeInfo {
	const repoPath = findRepoRoot(cwd);
	if (!repoPath) throw new Error("Not in a git repository");

	const branch = branchName(threadId);
	const wtPath = worktreePath(repoPath, threadId);

	// Create the branch if it doesn't exist
	try {
		execSync(`git branch ${branch} ${baseBranch ?? "HEAD"}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
	} catch {
		// Branch may already exist from a previous run — that's fine
	}

	// Create worktree
	execSync(`git worktree add ${wtPath} ${branch}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" });

	const info: WorktreeInfo = {
		path: wtPath,
		branch,
		threadId,
		createdAt: Date.now(),
		ahead: 0,
		behind: 0,
		dirty: false,
	};

	const reg = loadRegistry(repoPath);
	// Remove any stale entry for this thread
	const filtered = reg.filter((w) => w.threadId !== threadId);
	filtered.push(info);
	saveRegistry(repoPath, filtered);
	worktreeRegistry = filtered;

	return info;
}

/**
 * Remove a worktree and its branch
 */
export function removeWorktree(cwd: string, threadId: string): boolean {
	const repoPath = findRepoRoot(cwd);
	if (!repoPath) return false;

	const branch = branchName(threadId);
	const wtPath = worktreePath(repoPath, threadId);

	let success = true;

	// Remove worktree
	try {
		execSync(`git worktree remove ${wtPath}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
	} catch {
		// Force remove if locked
		try {
			execSync(`git worktree remove --force ${wtPath}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
		} catch {
			success = false;
		}
	}

	// Delete branch
	try {
		execSync(`git branch -D ${branch}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
	} catch {
		// Branch may not exist
	}

	// Clean up directory
	try {
		rmSync(wtPath, { recursive: true, force: true });
	} catch { /* best effort */ }

	// Update registry
	const reg = loadRegistry(repoPath);
	const filtered = reg.filter((w) => w.threadId !== threadId);
	saveRegistry(repoPath, filtered);
	worktreeRegistry = filtered;

	return success;
}

/**
 * Get divergence stats for a worktree branch
 */
function getDivergence(repoPath: string, branch: string): { ahead: number; behind: number } {
	try {
		const ahead = parseInt(
			execSync(`git rev-list --count HEAD..origin/${branch}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" }).trim() || "0",
			10
		);
		const behind = parseInt(
			execSync(`git rev-list --count origin/${branch}..HEAD`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" }).trim() || "0",
			10
		);
		return { ahead, behind };
	} catch {
		return { ahead: 0, behind: 0 };
	}
}

/**
 * Check if a worktree has uncommitted changes
 */
function isDirty(path: string): boolean {
	try {
		const status = execSync("git status --porcelain", { cwd: path, encoding: "utf8", stdio: "pipe" }).trim();
		return status.length > 0;
	} catch {
		return false;
	}
}

/**
 * List all worktrees with their divergence stats
 */
export function listWorktrees(cwd: string): WorktreeInfo[] {
	const repoPath = findRepoRoot(cwd);
	if (!repoPath) return [];

	const reg = loadRegistry(repoPath);

	// Refresh stats
	return reg.map((w) => {
		const div = getDivergence(repoPath, w.branch);
		const dirty = existsSync(w.path) ? isDirty(w.path) : false;
		return { ...w, ...div, dirty };
	});
}

/**
 * Collect worktree results — reads the output file from a finished thread
 */
export function collectWorktreeResult(threadId: string, worktree: WorktreeInfo): string | null {
	const resultFile = join(worktree.path, ".pi-thread-result.json");
	if (existsSync(resultFile)) {
		try {
			return readFileSync(resultFile, "utf8");
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Clean up ALL worktrees for this repo (emergency / force cleanup)
 */
export function cleanupAll(cwd: string): { removed: number; failed: number } {
	const repoPath = findRepoRoot(cwd);
	if (!repoPath) return { removed: 0, failed: 0 };

	const reg = loadRegistry(repoPath);
	let removed = 0;
	let failed = 0;

	for (const w of reg) {
		if (removeWorktree(cwd, w.threadId)) removed++;
		else failed++;
	}

	saveRegistry(repoPath, []);
	worktreeRegistry = [];

	return { removed, failed };
}

/**
 * Push worktree changes back to the main repo
 */
export function pushWorktreeChanges(cwd: string, threadId: string, message?: string): boolean {
	const repoPath = findRepoRoot(cwd);
	if (!repoPath) return false;

	const wtPath = worktreePath(repoPath, threadId);
	if (!existsSync(wtPath)) return false;

	try {
		// Commit any uncommitted changes
		const status = execSync("git status --porcelain", { cwd: wtPath, encoding: "utf8", stdio: "pipe" }).trim();
		if (status) {
			execSync(`git add -A`, { cwd: wtPath, encoding: "utf8", stdio: "pipe" });
			const defaultMsg = `[pi-threads] ${threadId} worktree changes`;
			execSync(`git commit -m "${message ?? defaultMsg}"`, { cwd: wtPath, encoding: "utf8", stdio: "pipe" });
		}
		return true;
	} catch {
		return false;
	}
}
