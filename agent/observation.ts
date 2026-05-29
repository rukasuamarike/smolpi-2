import type { Message } from "./context";

// Tools whose output may contain adversarial instructions injected from external
// sources (web pages, remote APIs). Wrapping in <external_data> tags signals to
// the model that this content is data to be interpreted, not commands to follow.
// OWASP LLM01: Prompt Injection — the observation stage is the primary trust boundary.
const EXTERNAL_TOOLS = new Set(["browse"]);

// Observations larger than this threshold are elided to pointers in older history
// to prevent context bloat across long sessions. The agent can re-run the command
// if it needs the content again.
export const OBS_ELIDE_THRESHOLD = Number(process.env.OBS_ELIDE_THRESHOLD ?? 1200);

// Wrap external tool output in a neutral delimiter so the model treats it as
// data, not executable instructions. Shell output is trusted (the agent wrote
// the command); web fetches are not.
export function formatObservation(raw: string, tool: string): string {
  if (!EXTERNAL_TOOLS.has(tool)) return raw;
  return `<external_data source="${tool}">\n${raw}\n</external_data>`;
}

// Replace large observations in the message history with compact pointers before
// the sliding-window trim runs. This is a permanent operation on the persistent
// messages array — the agent sees "[content elided: N chars — re-run to retrieve]"
// in subsequent steps. skipTail protects the N most recent user messages so the
// model always sees the fresh result of its last action verbatim.
export function compactLargeObservations(
  messages: Message[],
  threshold = OBS_ELIDE_THRESHOLD,
  skipTail = 1,
): { messages: Message[]; elided: number } {
  let elided = 0;
  const cutoff = messages.length - skipTail;
  const out = messages.map((m, i) => {
    if (m.role !== "user" || i >= cutoff) return m;
    const match = m.content.match(/^Observation:\n([\s\S]+)$/);
    if (!match || match[1].length <= threshold) return m;
    elided++;
    return {
      ...m,
      content: `Observation:\n[content elided: ${match[1].length} chars — re-run the preceding command to retrieve if needed]`,
    };
  });
  return { messages: out, elided };
}
