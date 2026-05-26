// smolpi compat shim for pi.dev's pi-ai. Only StringEnum is used as a value by
// the vendored extensions (to build tool param schemas).
export function StringEnum(values, options = {}) {
  return { type: "string", enum: [...values], ...options };
}
