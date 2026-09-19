import { describe, expect, it } from "vitest";
import {
  buildThreadId,
  decodeThreadId,
  getAllThreadMessageIds,
} from "./thread";

describe("IMAP threading", () => {
  it("groups the original and replies despite bracket formatting", () => {
    const original = buildThreadId(undefined, undefined, "<root@example.com>");
    const reply = buildThreadId(
      "<root@example.com> <parent@example.com>",
      "<parent@example.com>",
      "<reply@example.com>",
    );
    expect(reply).toBe(original);
    expect(
      buildThreadId(undefined, "root@example.com", "reply2@example.com"),
    ).toBe(original);
    expect(decodeThreadId(original)).toEqual({ root: "root@example.com" });
  });
  it("never conflates unrelated mail with missing headers", () => {
    expect(buildThreadId(undefined, undefined, undefined, "folder:1")).not.toBe(
      buildThreadId(undefined, undefined, undefined, "folder:2"),
    );
    expect(() => buildThreadId(undefined, undefined, undefined)).toThrow();
  });
  it("deduplicates normalized reference chains", () => {
    expect(
      getAllThreadMessageIds(
        "<root@example.com> <parent@example.com>",
        "parent@example.com",
        "<reply@example.com>",
      ),
    ).toEqual(["root@example.com", "parent@example.com", "reply@example.com"]);
  });
});
