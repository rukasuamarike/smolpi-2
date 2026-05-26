// smolpi compat shim for pi.dev's pi-tui. Only the interactive /memory-skills
// modal uses these; headless smolpi never invokes it, so no-op stubs suffice.
export class Input {}
export const Key = {};
export function fuzzyFilter(items = []) { return items; }
export function matchesKey() { return false; }
export function truncateToWidth(s = "") { return s; }
export function visibleWidth(s = "") { return String(s).length; }
export function wrapTextWithAnsi(s = "") { return s; }
