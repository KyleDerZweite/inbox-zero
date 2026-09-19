import { describe, expect, it, vi } from "vitest";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { draftMessageId, saveDraft } from "./draft";

describe("IMAP draft MIME", () => {
  it("saves stable Message-ID, Bcc, UTF-8 content and binary attachments", async () => {
    const append = vi.fn().mockResolvedValue({ uid: 123 });
    const client = {
      list: vi
        .fn()
        .mockResolvedValue([
          { path: "Drafts", specialUse: "\\Drafts", flags: new Set() },
        ]),
      append,
    } as unknown as ImapFlow;
    const id = await saveDraft(client, {
      from: "me@example.com",
      to: "you@example.com",
      bcc: "hidden@example.com",
      subject: "Grüße\r\nX-Forged: yes",
      messageId: "<stable@example.com>",
      html: "<p>你好</p>",
      attachments: [
        { filename: "bytes.bin", content: Buffer.from([0, 255, 10]) },
      ],
    });
    const parsed = await simpleParser(append.mock.calls[0][1]);
    expect(draftMessageId(id)).toBe("<stable@example.com>");
    expect(parsed.messageId).toBe("<stable@example.com>");
    expect(parsed.bcc).toMatchObject({ text: "hidden@example.com" });
    expect(parsed.headers.has("x-forged")).toBe(false);
    expect(parsed.html).toContain("你好");
    expect(parsed.attachments[0].content).toEqual(Buffer.from([0, 255, 10]));
  });
  it("does not report a saved draft if APPEND fails", async () => {
    const client = {
      list: vi.fn().mockResolvedValue([{ path: "Drafts", flags: new Set() }]),
      append: vi.fn().mockResolvedValue(false),
    } as unknown as ImapFlow;
    await expect(saveDraft(client, { to: "you@example.com" })).rejects.toThrow(
      "Saving IMAP draft failed",
    );
  });
});
