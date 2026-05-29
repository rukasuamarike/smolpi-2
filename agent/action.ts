export type Action =
  | { kind: "sh" | "browse"; arg: string }
  | { kind: "tool"; name: string; arg: string }
  | { kind: "done" }
  | null;

// Robust parse: tag form (multiline, tolerant of inner `]`) preferred; legacy
// [sh:]/[browse:] kept as a fallback. Earliest action wins (one per step), so a
// reply with both a shell and a browse no longer silently drops the first.
export function parseAction(reply: string): Action {
  // `<done/>` is TERMINAL. The model signals completion with it, and its final
  // answer often contains example commands in <sh> tags for documentation — we
  // must NOT execute those. Done wins over any trailing action.
  if (/<done\s*\/?>|\[done\]/i.test(reply)) return { kind: "done" };

  const cands: { idx: number; kind: "sh" | "browse" | "tool"; arg: string; name?: string }[] = [];
  const first = (re: RegExp, kind: "sh" | "browse") => {
    const m = re.exec(reply);
    if (m && m[1].trim()) cands.push({ idx: m.index, kind, arg: m[1].trim() });
  };

  // Accept both <tool name="X">{json}</tool> and self-closing <tool name="X"/>.
  const mTool = /<tool\s+name="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/tool>)/i.exec(reply);
  if (mTool) cands.push({ idx: mTool.index, kind: "tool", name: mTool[1], arg: (mTool[2] ?? "").trim() });
  first(/<sh>([\s\S]*?)<\/sh>/i, "sh");
  first(/<browse>([\s\S]*?)<\/browse>/i, "browse");
  if (!cands.length) {
    // legacy fallback
    first(/\[browse:\s*([^\]\n]+)\]/i, "browse");
    first(/\[sh:([\s\S]+)\]/i, "sh"); // greedy to last ] — tolerates inner ]
  }

  if (cands.length) {
    cands.sort((a, b) => a.idx - b.idx);
    const e = cands[0]; // earliest action wins (one per step)
    return e.kind === "tool"
      ? { kind: "tool", name: e.name!, arg: e.arg }
      : { kind: e.kind, arg: e.arg };
  }
  return null; // no action and no done → treat the reply as a final answer
}
