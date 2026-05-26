# Plan: Git Worktree Threads for pi-thread-engine

## Why
Orca and pi-builder both have worktree support. pi-thread-engine doesn't. Worktrees give each thread its own isolated branch + working directory, so parallel agents never conflict.

## What We're Building
A new `/wthread` command that creates a git worktree, runs a thread inside it, and tracks divergence from main.

## Files to Change

### New: `src/core/worktree.ts` (~60 lines)
- `createWorktree(repoPath, threadId)` → creates worktree + branch
- `removeWorktree(threadId)` → removes worktree + deletes branch
- `listWorktrees()` → returns worktree info (branch, path, ahead/behind, dirty)
- Uses `git worktree` CLI commands (no Rust dependency)

### Modify: `extensions/index.ts` (+80 lines)
- Add `/wthread "task"` — spawn thread in a worktree
- Add `/wthread list` — show worktrees with divergence
- Register as ThreadType "worktree" in registry
- Wire cleanup on thread completion/kill

### Modify: `src/core/registry.ts` (+5 lines)
- Add "worktree" as accepted ThreadType

### Modify: `src/core/types.ts` (+5 lines)
- Add "worktree" to ExecutionBackend or ThreadType

## API
```
/wthread "refactor auth"           → create worktree, run task, report results
/wthread "fix parser" -b fix/parse → use custom branch name
/wthread list                       → show all active worktrees
```

## Worktree Lifecycle
1. `git worktree add -b pi-thread/t-001 <path>` — create
2. Thread runs in worktree directory using `pi -p "task"` (native backend)
3. On completion: results captured, divergence tracked
4. On cleanup: `git worktree remove <path>`, `git branch -D <branch>`
5. Worktrees stored under `<repo>/.git/worktrees-pi/`

## Test Strategy
1. Run `/wthread "echo hello"` in a git repo
2. Verify worktree appears (`git worktree list`)
3. Run thread, verify results captured
4. Remove worktree, verify cleanup
5. Test with non-git repo (graceful error)

## Risks
- Windows path handling in git worktree (tested: works)
- Cleanup on pi crash (worktrees persist, need manual cleanup)
- Branch name collisions (use unique names with thread ID)
