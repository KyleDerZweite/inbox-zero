import { describe, expect, it, vi } from "vitest";
import type { FetchMessageObject, ImapFlow, MailboxObject } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  convertImapMessage,
  fetchMessageByUid,
  parseSearchQuery,
  searchImapMessages,
} from "./message";
import { decodeMessageId } from "./ids";
import { buildThreadId } from "./thread";

const mailbox = {
  path: "INBOX",
  uidValidity: BigInt(123),
  exists: 1,
} as MailboxObject;

describe("IMAP message hydration", () => {
  it("preserves threading, body, unsubscribe headers, and downloadable attachments", async () => {
    const source = await new MailComposer({
      from: "sender@example.com",
      to: "me@example.com",
      subject: "Document",
      messageId: "<reply@example.com>",
      references: "<original@example.com>",
      html: '<p>Hello<img src="cid:image"></p>',
      text: "Hello",
      headers: { "List-Unsubscribe": "<https://example.com/unsubscribe>" },
      attachments: [
        { filename: "hello.txt", content: Buffer.from("file") },
        { filename: "image.png", content: Buffer.from([1, 2]), cid: "image" },
      ],
    })
      .compile()
      .build();
    const message = await convertImapMessage(
      {
        uid: 8,
        flags: new Set(["\\Flagged"]),
        envelope: {
          messageId: "<reply@example.com>",
          subject: "Document",
          from: [{ address: "sender@example.com" }],
          to: [{ address: "me@example.com" }],
        },
        source,
      } as FetchMessageObject,
      mailbox,
    );
    expect(message?.threadId).toBe(
      buildThreadId(undefined, undefined, "<original@example.com>"),
    );
    expect(message?.textPlain).toContain("Hello");
    expect(message?.textHtml).toContain("cid:image");
    expect(message?.headers["list-unsubscribe"]).toContain(
      "example.com/unsubscribe",
    );
    expect(message?.labelIds).toEqual(
      expect.arrayContaining(["INBOX", "UNREAD", "STARRED"]),
    );
    expect(message?.attachments).toHaveLength(1);
    expect(message?.inline).toHaveLength(1);
    expect(message?.attachments?.[0]).toMatchObject({
      filename: "hello.txt",
      size: 4,
      attachmentId: expect.any(String),
    });
    expect(decodeMessageId(message!.id)).toMatchObject({
      folder: "INBOX",
      uidValidity: "123",
      uid: 8,
    });
  });
  it("keeps metadata-only and hydrated replies in the same thread", async () => {
    const message = {
      uid: 9,
      flags: new Set(["\\Seen"]),
      envelope: {
        messageId: "<reply@example.com>",
        inReplyTo: "<parent@example.com>",
      },
      headers: Buffer.from(
        "References: <root@example.com> <parent@example.com>\r\n\r\n",
      ),
    } as FetchMessageObject;
    const parsed = await convertImapMessage(message, mailbox);
    expect(parsed?.threadId).toBe(
      buildThreadId(undefined, undefined, "<root@example.com>"),
    );
    expect(parsed?.labelIds).not.toContain("UNREAD");
  });
  it("surfaces provider failures instead of returning empty mail", async () => {
    const client = {
      fetchOne: vi.fn().mockRejectedValue(new Error("offline")),
      search: vi.fn().mockResolvedValue(false),
    } as unknown as ImapFlow;
    await expect(fetchMessageByUid(client, 1)).rejects.toThrow("offline");
    await expect(searchImapMessages(client, { all: true })).rejects.toThrow(
      "search failed",
    );
  });
});

describe("IMAP search", () => {
  it("supports quoted subjects and rejects unsupported operators", () => {
    expect(parseSearchQuery('subject:"meeting notes"')).toEqual({
      subject: "meeting notes",
    });
    expect(parseSearchQuery("is:unread")).toEqual({ seen: false });
    expect(parseSearchQuery("invoice")).toEqual({ text: "invoice" });
    expect(() => parseSearchQuery("has:attachment")).toThrow("Unsupported");
    expect(() => parseSearchQuery("before:invalid")).toThrow(
      "Invalid search date",
    );
  });
});
