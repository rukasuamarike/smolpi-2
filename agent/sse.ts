export function parseSseBuffer(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const events: string[] = [];
  let start = 0;
  while (true) {
    const idx = normalized.indexOf("\n\n", start);
    if (idx === -1) break;
    const raw = normalized.slice(start, idx);
    start = idx + 2;
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) events.push(data);
  }
  return { events, rest: normalized.slice(start) };
}
