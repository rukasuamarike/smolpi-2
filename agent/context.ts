export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TrimResult {
  messages: Message[];
  droppedCount: number;
}

// Sliding-window trim so a long multi-step run doesn't overflow the context
// window. Always keeps the system prompt and the original task (rubric #3:
// re-inject load-bearing instructions); drops oldest observations first.
// Returns droppedCount so callers can inject a compaction notice into the
// sendable slice without mutating the persistent message history.
export function trimContext(messages: Message[], budget: number): TrimResult {
  const total = messageChars(messages);
  if (total <= budget) return { messages, droppedCount: 0 };

  const system = messages[0];
  const firstUserIdx = messages.findIndex((m, i) => i > 0 && m.role === "user");
  const firstUser = firstUserIdx >= 0 ? messages[firstUserIdx] : null;

  let used = system.content.length + (firstUser?.content.length ?? 0);
  const tail: Message[] = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    if (i === firstUserIdx) continue;
    const m = messages[i];
    if (used + m.content.length > budget) break;
    used += m.content.length;
    tail.unshift(m);
  }
  const head: Message[] = [system];
  if (firstUser) head.push(firstUser);

  const nonAnchorCount = messages.length - 1 - (firstUser ? 1 : 0);
  const droppedCount = nonAnchorCount - tail.length;
  return { messages: head.concat(tail), droppedCount };
}

// Insert a synthetic user notice after the task anchor so the model knows
// older observations were evicted. Operates on the sendable slice only —
// never mutate the persistent messages array.
export function insertCompactionNotice(messages: Message[], droppedCount: number): Message[] {
  const anchorEnd = messages.findIndex((m, i) => i > 0 && m.role === "user") + 1;
  const notice: Message = {
    role: "user",
    content: `[harness: context compacted — ${droppedCount} older observation(s) dropped; current task and recent steps retained]`,
  };
  return [...messages.slice(0, anchorEnd), notice, ...messages.slice(anchorEnd)];
}

export function messageChars(messages: Message[]): number {
  return messages.reduce((n, m) => n + m.content.length, 0);
}
