import { describe, expect, test } from "bun:test";
import { insertCompactionNotice, messageChars, trimContext, type Message } from "../../agent/context";

const msg = (role: Message["role"], content: string): Message => ({ role, content });

describe("context trimming", () => {
  test("does not trim when under budget", () => {
    const messages = [msg("system", "sys"), msg("user", "task"), msg("assistant", "ok")];
    const { messages: out, droppedCount } = trimContext(messages, 100);
    expect(out).toEqual(messages);
    expect(droppedCount).toBe(0);
    expect(messageChars(messages)).toBe(9);
  });

  test("retains system and first user while dropping oldest tail first", () => {
    const messages = [
      msg("system", "SYS"),
      msg("user", "TASK"),
      msg("assistant", "old-assistant"),
      msg("user", "old-observation"),
      msg("assistant", "new"),
      msg("user", "latest"),
    ];
    const { messages: out, droppedCount } = trimContext(messages, 20);
    expect(out).toEqual([
      msg("system", "SYS"),
      msg("user", "TASK"),
      msg("assistant", "new"),
      msg("user", "latest"),
    ]);
    expect(droppedCount).toBe(2);
  });

  test("documents current over-budget anchor behavior", () => {
    const messages = [msg("system", "S".repeat(10)), msg("user", "U".repeat(10)), msg("assistant", "tail")];
    const { messages: trimmed, droppedCount } = trimContext(messages, 5);
    expect(trimmed).toEqual([msg("system", "S".repeat(10)), msg("user", "U".repeat(10))]);
    expect(messageChars(trimmed)).toBeGreaterThan(5);
    expect(droppedCount).toBe(1);
  });
});

describe("insertCompactionNotice", () => {
  test("inserts notice after first user anchor", () => {
    const messages = [
      msg("system", "sys"),
      msg("user", "task"),
      msg("assistant", "step1"),
      msg("user", "obs1"),
    ];
    const out = insertCompactionNotice(messages, 3);
    expect(out[0]).toEqual(msg("system", "sys"));
    expect(out[1]).toEqual(msg("user", "task"));
    expect(out[2].role).toBe("user");
    expect(out[2].content).toContain("3 older observation(s) dropped");
    expect(out[3]).toEqual(msg("assistant", "step1"));
    expect(out[4]).toEqual(msg("user", "obs1"));
  });

  test("does not mutate the input array", () => {
    const messages = [msg("system", "sys"), msg("user", "task")];
    insertCompactionNotice(messages, 1);
    expect(messages).toHaveLength(2);
  });
});
