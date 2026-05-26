// smolpi compat shim. pi-hermes-memory's db.ts catches this exact message and
// transparently falls back to Bun's built-in `bun:sqlite` (real + functional).
// We don't ship the native better-sqlite3 addon.
throw new Error("better-sqlite3 is not yet supported in bun");
