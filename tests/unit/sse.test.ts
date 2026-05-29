import { describe, expect, test } from "bun:test";
import { parseSseBuffer } from "../../agent/sse";

describe("parseSseBuffer", () => {
  test("returns complete events and preserves incomplete rest", () => {
    const parsed = parseSseBuffer('data: {"a":1}\n\ndata: {"b"');
    expect(parsed.events).toEqual(['{"a":1}']);
    expect(parsed.rest).toBe('data: {"b"');
  });

  test("normalizes CRLF event lines", () => {
    const parsed = parseSseBuffer('data: hello\r\ndata: world\r\n\r\n');
    expect(parsed.events).toEqual(["hello\nworld"]);
    expect(parsed.rest).toBe("");
  });

  test("passes DONE through to caller", () => {
    expect(parseSseBuffer("data: [DONE]\n\n")).toEqual({ events: ["[DONE]"], rest: "" });
  });
});
