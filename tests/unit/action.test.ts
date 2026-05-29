import { describe, expect, test } from "bun:test";
import { parseAction } from "../../agent/action";

describe("parseAction", () => {
  test("done beats executable tags", () => {
    expect(parseAction("<sh>rm -rf /tmp/nope</sh> all done <done/>"))
      .toEqual({ kind: "done" });
  });

  test("earliest action wins across tool, shell, and browse tags", () => {
    expect(parseAction("first <browse>https://example.com</browse> then <sh>pwd</sh>"))
      .toEqual({ kind: "browse", arg: "https://example.com" });

    expect(parseAction('<tool name="memctx_search">{"query":"x"}</tool><sh>pwd</sh>'))
      .toEqual({ kind: "tool", name: "memctx_search", arg: '{"query":"x"}' });
  });

  test("parses multiline shell tags", () => {
    expect(parseAction("<sh>\nprintf ok\npwd\n</sh>"))
      .toEqual({ kind: "sh", arg: "printf ok\npwd" });
  });

  test("keeps legacy bracket fallbacks", () => {
    expect(parseAction("use [browse: https://example.org]"))
      .toEqual({ kind: "browse", arg: "https://example.org" });
    expect(parseAction("run [sh: echo [ok]]"))
      .toEqual({ kind: "sh", arg: "echo [ok]" });
  });

  test("returns null for plain final answers", () => {
    expect(parseAction("No action here, just an answer.")).toBeNull();
  });
});
