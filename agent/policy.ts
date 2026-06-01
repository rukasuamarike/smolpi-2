import type { Action } from "./action";

export type ActionIntent =
  | "filesystem_read"
  | "filesystem_write"
  | "filesystem_delete"
  | "network_read"
  | "network_write"
  | "process_control"
  | "secret_access"
  | "tool"
  | "complete"
  | "unknown";

export type RiskClass = "low" | "medium" | "high";

export interface ActionRisk {
  intent: ActionIntent;
  riskClass: RiskClass;
  // TODO(permission): widen this from the auto_allow literal to a decision enum (auto_allow | checkpoint | deny) so high-risk intents (secret_access/filesystem_delete) can trigger a human checkpoint instead of being recorded as allowed. (plan Task 8 "later"; README near-term #8)
  policy: "auto_allow";
  policyReason: string;
}

export function classifyActionRisk(action: Exclude<Action, null>): ActionRisk {
  if (action.kind === "done") {
    return { intent: "complete", riskClass: "low", policy: "auto_allow", policyReason: "completion marker" };
  }
  if (action.kind === "browse") {
    return { intent: "network_read", riskClass: "low", policy: "auto_allow", policyReason: "browse action is read-only HTTP fetch" };
  }
  if (action.kind === "tool") {
    return { intent: "tool", riskClass: "medium", policy: "auto_allow", policyReason: "tool risk is delegated to tool adapter; enforcement unchanged" };
  }

  const cmd = action.arg.trim().toLowerCase();
  const has = (re: RegExp) => re.test(cmd);

  if (has(/(~\/\.ssh|\.ssh\/|id_rsa|id_ed25519|\.env\b|api[_-]?key|secret|token|credential)/)) {
    return { intent: "secret_access", riskClass: "high", policy: "auto_allow", policyReason: "command references credential-like path or token" };
  }
  if (has(/\b(rm\s+(-[^\n]*[rf][^\n]*|.*\s-rf\b)|shred|mkfs|dd\s+if=|truncate\s+-s\s*0)\b/)) {
    return { intent: "filesystem_delete", riskClass: "high", policy: "auto_allow", policyReason: "destructive filesystem command pattern" };
  }
  if (has(/\b(curl|wget|httpie|http)\b/) && has(/\b(-x|--request|post|put|patch|delete)\b|\b--data\b|\b-d\b/)) {
    return { intent: "network_write", riskClass: "high", policy: "auto_allow", policyReason: "network command appears to send a mutating request" };
  }
  if (has(/(^|\s)(>|>>|tee\b|touch\b|mkdir\b|mv\b|cp\b|chmod\b|chown\b|git\s+commit\b|git\s+add\b|npm\s+install\b|bun\s+install\b)/)) {
    return { intent: "filesystem_write", riskClass: "medium", policy: "auto_allow", policyReason: "command may write local filesystem state" };
  }
  if (has(/\b(kill|pkill|systemctl|service|docker|smolvm\s+machine\s+(stop|delete)|process)\b/)) {
    return { intent: "process_control", riskClass: "medium", policy: "auto_allow", policyReason: "command controls processes or services" };
  }
  if (has(/^\s*(pwd|git\s+(status|diff|log|show)|ls\b|find\b|rg\b|grep\b|sed\s+-n\b|wc\b|cat\b|printf\b|echo\b|date\b|uname\b)/)) {
    return { intent: "filesystem_read", riskClass: "low", policy: "auto_allow", policyReason: "recognized read-only shell command" };
  }
  if (has(/\b(curl|wget|httpie|http)\b/)) {
    return { intent: "network_read", riskClass: "medium", policy: "auto_allow", policyReason: "network read command" };
  }

  return { intent: "unknown", riskClass: "medium", policy: "auto_allow", policyReason: "unrecognized command; enforcement unchanged" };
}
