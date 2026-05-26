// smolpi compat shim for pi.dev's pi-coding-agent. Extensions import types from
// here (erased at runtime); the only value used is isToolCallEventType, by
// llm-wiki guardrails to gate the runtime's write/edit tools. smolpi has no
// generic write tool, so returning false (never matches) is safe.
export function isToolCallEventType() {
  return false;
}
