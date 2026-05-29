import { describe, expect, test } from "bun:test";
import { classifyActionRisk } from "../../agent/policy";

describe("classifyActionRisk", () => {
  test("classifies common read-only shell commands", () => {
    expect(classifyActionRisk({ kind: "sh", arg: "git status --short" }).intent).toBe("filesystem_read");
    expect(classifyActionRisk({ kind: "browse", arg: "https://example.com" }).intent).toBe("network_read");
  });

  test("classifies writes, deletes, network writes, and secret-ish reads", () => {
    expect(classifyActionRisk({ kind: "sh", arg: "printf hi > out.txt" }).intent).toBe("filesystem_write");
    expect(classifyActionRisk({ kind: "sh", arg: "rm -rf build" }).intent).toBe("filesystem_delete");
    expect(classifyActionRisk({ kind: "sh", arg: "curl -X POST https://api.example.com" }).intent).toBe("network_write");
    expect(classifyActionRisk({ kind: "sh", arg: "cat ~/.ssh/id_rsa" }).intent).toBe("secret_access");
  });

  test("unknown shell commands are not mislabeled benign", () => {
    const risk = classifyActionRisk({ kind: "sh", arg: "custom-mutator --maybe" });
    expect(risk.intent).toBe("unknown");
    expect(risk.riskClass).toBe("medium");
  });
});
