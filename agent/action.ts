export type Action =
  | { kind: "sh" | "browse"; arg: string }
  | { kind: "tool"; name: string; arg: string }
  | { kind: "done" }
  | null;

// Robust parse: tag form (multiline, tolerant of inner `]`) preferred; legacy
// [sh:]/[browse:] kept as a fallback. Earliest action wins (one per step), so a
// reply with both a shell and a browse no longer silently drops the first.
export function parseAction(reply: string): Action {
  // A live <sh>/<tool>/<browse> tag ALWAYS means execute — the prompt reserves
  // plain backticks for commands shown but not run. So we look for an action
  // FIRST and let it win even when the reply also contains <done/>: small models
  // routinely pair "do X" with a premature <done/>, and silently dropping the
  // action stranded them with no observation (and a false "✓ done"). The <done/>
  // is ignored for that step; the model finishes on a later step. <done/> is
  // terminal only when the reply carries no action (handled at the bottom).
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
    const e = cands[0]; // earliest action wins (one per step), even over <done/>
    return e.kind === "tool"
      ? { kind: "tool", name: e.name!, arg: e.arg }
      : { kind: e.kind, arg: e.arg };
  }
  if (/<done\s*\/?>|\[done\]/i.test(reply)) return { kind: "done" }; // terminal only when no action
  return null; // no action and no done → treat the reply as a final answer
}
