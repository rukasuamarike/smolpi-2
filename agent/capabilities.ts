// Self-describing skill registry. Add a new entry here and the system
// prompt will pick it up automatically (after validation by which/exists).

export type CapabilityGroup = "WEB" | "SEARCH" | "FILES" | "SYSTEM";

export interface Capability {
  name: string;
  group: CapabilityGroup;
  description: string; // internal note — never sent to the LLM
  usage: string;       // the action format, e.g. "[sh:rg PATTERN]"
  snippet: string;     // 1-line manual entry the LLM sees under the group header
  check?: string;      // binary name (which) or absolute path (file existence)
}

export const capabilities: Capability[] = [
  // ── WEB ────────────────────────────────────────────────────
  {
    name: "browse",
    group: "WEB",
    description: "browser39 (Rust single binary, no Chromium) → token-efficient Markdown",
    usage: "[browse:URL]",
    snippet: "[browse:URL] — Get a semantic Markdown view of a page.",
    check: "browser39",
  },

  // ── SEARCH ─────────────────────────────────────────────────
  {
    name: "rg",
    group: "SEARCH",
    description: "ripgrep — fast recursive grep",
    usage: "[sh:rg PATTERN [PATH]]",
    snippet: "rg <pattern> — Fast recursive text search.",
    check: "rg",
  },
  {
    name: "fd",
    group: "SEARCH",
    description: "fd — fast file finder",
    usage: "[sh:fd PATTERN [PATH]]",
    snippet: "fd <pattern> — Fast file finder (use over find).",
    check: "fd",
  },

  // ── FILES ──────────────────────────────────────────────────
  {
    name: "bat",
    group: "FILES",
    description: "syntax-highlighted file viewer",
    usage: "[sh:bat FILE]",
    snippet: "bat <file> — Read file with syntax highlighting.",
    check: "bat",
  },
  {
    name: "sed",
    group: "FILES",
    description: "stream editor for in-place edits",
    usage: "[sh:sed -i 's/OLD/NEW/g' FILE]",
    snippet: "sed -i 's/OLD/NEW/g' <file> — In-place text replacement.",
    check: "sed",
  },
  {
    name: "jq",
    group: "FILES",
    description: "JSON transformer",
    usage: "[sh:jq FILTER FILE]",
    snippet: "jq <filter> <file> — Parse/transform JSON.",
    check: "jq",
  },
  {
    name: "nvim",
    group: "FILES",
    description: "editor (interactive — prefer sed for scripted edits)",
    usage: "[sh:nvim FILE]",
    snippet: "nvim <file> — Editor (use sed for non-interactive edits).",
    check: "nvim",
  },

  // ── SYSTEM ─────────────────────────────────────────────────
  // TODO(tool-design): `z` is advertised because the zoxide BINARY exists (check passes), but `z` is a shell FUNCTION defined only in .bashrc.smol, which shell()'s non-interactive `bash -c` never sources — so [sh:z DIR] fails at runtime. Drop this advert or make shell() source the env. (README near-term #5 no advertised-but-broken tools)
  {
    name: "z",
    group: "SYSTEM",
    description: "zoxide — smart cd by frecency",
    usage: "[sh:z DIR]",
    snippet: "z <dir> — Jump to a frequently-used directory.",
    check: "zoxide",
  },
  {
    name: "btop",
    group: "SYSTEM",
    description: "resource monitor",
    usage: "[sh:btop -p 1]",
    snippet: "btop — Process and resource monitor.",
    check: "btop",
  },
  {
    name: "cowsay",
    group: "SYSTEM",
    description: "ASCII speech-bubble — flair for announcements",
    usage: "[sh:cowsay TEXT]",
    snippet: "cowsay <text> — ASCII speech-bubble. Use sparingly, for celebrations or final reports.",
    check: "cowsay",
  },
  {
    name: "sh",
    group: "SYSTEM",
    description: "arbitrary shell — escape hatch",
    usage: "[sh:COMMAND]",
    snippet: "[sh:COMMAND] — Run any other shell command.",
    // no check: bash is always available
  },
];

export const GROUP_TITLES: Record<CapabilityGroup, string> = {
  WEB: "WEB",
  SEARCH: "SEARCH",
  FILES: "FILES",
  SYSTEM: "SYSTEM",
};

export const GROUP_ORDER: CapabilityGroup[] = ["WEB", "SEARCH", "FILES", "SYSTEM"];

export async function isAvailable(cap: Capability): Promise<boolean> {
  if (!cap.check) return true;

  // Absolute paths: file existence check
  if (cap.check.startsWith("/")) {
    return await Bun.file(cap.check).exists();
  }

  // Bare names: resolve via `which`
  const proc = Bun.spawn(["which", cap.check], {
    stdout: "pipe",
    stderr: "ignore",
  });
  await new Response(proc.stdout).text();
  await proc.exited;
  return proc.exitCode === 0;
}

export async function activeCapabilities(): Promise<Capability[]> {
  const checks = await Promise.all(
    capabilities.map(async (c) => ({ cap: c, ok: await isAvailable(c) })),
  );
  return checks.filter(({ ok }) => ok).map(({ cap }) => cap);
}
