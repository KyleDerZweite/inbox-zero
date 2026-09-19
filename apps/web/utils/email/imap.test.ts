import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchMessageObject, MailboxObject, SearchObject } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import { simpleParser } from "mailparser";
import { ImapProvider } from "./imap";
import { encodeMessageId } from "@/utils/imap/ids";
import { buildThreadId } from "@/utils/imap/thread";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  client: {} as Record<string, unknown>,
  send: vi.fn(),
  acquire: vi.fn(),
  clear: vi.fn(),
  processed: vi.fn(),
}));
vi.mock("@/utils/imap/client", () => ({
  withImapConnection: (
    _config: unknown,
    callback: (client: unknown) => unknown,
  ) => callback(mocks.client),
}));
vi.mock("@/utils/imap/mail", () => ({
  sendSmtpEmail: (...args: unknown[]) => mocks.send(...args),
}));
vi.mock("@/utils/redis/owned-lock", () => ({
  acquireOwnedLock: (...args: unknown[]) => mocks.acquire(...args),
  clearOwnedLock: (...args: unknown[]) => mocks.clear(...args),
  markOwnedLockProcessed: (...args: unknown[]) => mocks.processed(...args),
}));

const provider = new ImapProvider({
  email: "me@example.com",
  emailAccountId: "account",
  username: "me",
  password: "test",
  imapHost: "localhost",
  imapPort: 1143,
  imapSecurity: "starttls",
  smtpHost: "localhost",
  smtpPort: 1025,
  smtpSecurity: "starttls",
});
let selected = "INBOX";
let folders: Map<string, Map<number, FetchMessageObject>>;
let validity = BigInt(1);

beforeEach(() => {
  vi.clearAllMocks();
  selected = "INBOX";
  validity = BigInt(1);
  folders = new Map(
    ["INBOX", "Sent", "Drafts", "Archive", "Trash"].map((name) => [
      name,
      new Map(),
    ]),
  );
  mocks.acquire.mockResolvedValue("lock");
  mocks.clear.mockResolvedValue(true);
  mocks.processed.mockResolvedValue(true);
  mocks.send.mockImplementation(async (_config, options) => ({
    messageId: options.messageId || "<sent@example.com>",
  }));
  Object.assign(mocks.client, {
    mailbox: { path: selected, uidValidity: validity },
    list: vi.fn(async () =>
      [...folders.keys()].map((path) => ({
        path,
        name: path,
        flags: new Set(),
        listed: true,
      })),
    ),
    mailboxOpen: vi.fn(async (path: string) => {
      if (!folders.has(path)) throw new Error("No such folder");
      selected = path;
      const mailbox = {
        path,
        uidValidity: validity,
        exists: folders.get(path)!.size,
      } as MailboxObject;
      mocks.client.mailbox = mailbox;
      return mailbox;
    }),
    search: vi.fn(async (criteria: SearchObject) =>
      [...folders.get(selected)!.values()]
        .filter((message) => matches(message, criteria))
        .map((message) => message.uid)
        .sort((a, b) => a - b),
    ),
    fetchOne: vi.fn(
      async (uid: string) => folders.get(selected)!.get(Number(uid)) || false,
    ),
    fetch: vi.fn(async function* (range: string) {
      for (const uid of range.split(",").map(Number)) {
        const message = folders.get(selected)!.get(uid);
        if (message) yield message;
      }
    }),
    messageMove: vi.fn(async (uid: string, target: string) => {
      const message = folders.get(selected)!.get(Number(uid));
      if (!message) return false;
      folders.get(selected)!.delete(Number(uid));
      const nextUid = 1000 + message.uid;
      folders.get(target)!.set(nextUid, { ...message, uid: nextUid });
      return { uidMap: new Map([[message.uid, nextUid]]) };
    }),
    messageFlagsAdd: vi.fn(async (uid: string, flags: string[]) => {
      flags.forEach((flag) =>
        folders.get(selected)!.get(Number(uid))!.flags!.add(flag),
      );
      return true;
    }),
    messageFlagsRemove: vi.fn(async (uid: string, flags: string[]) => {
      flags.forEach((flag) =>
        folders.get(selected)!.get(Number(uid))!.flags!.delete(flag),
      );
      return true;
    }),
    messageDelete: vi.fn(async (range: string) => {
      range
        .split(",")
        .forEach((uid) => folders.get(selected)!.delete(Number(uid)));
      return true;
    }),
    append: vi.fn(async (folder: string, source: Buffer) => {
      const parsed = await simpleParser(source);
      const uid = 1 + Math.max(0, ...folders.get(folder)!.keys());
      folders.get(folder)!.set(uid, {
        uid,
        source,
        flags: new Set(["\\Draft"]),
        envelope: {
          messageId: parsed.messageId,
          subject: parsed.subject,
          from: parsed.from?.value,
          to: Array.isArray(parsed.to) ? parsed.to[0].value : parsed.to?.value,
        },
      } as FetchMessageObject);
      return { uid, uidValidity: validity };
    }),
  });
});

describe("IMAP core operations", () => {
  it("reads and marks the intended folder when UIDs collide, and rejects a mailbox reset", async () => {
    await addMessage("INBOX", 7, "<inbox@example.com>");
    await addMessage("Sent", 7, "<sent@example.com>");
    const id = encodeMessageId(
      { path: "Sent", uidValidity: BigInt(1) },
      7,
      "<sent@example.com>",
    );
    expect((await provider.getMessage(id)).headers["message-id"]).toBe(
      "<sent@example.com>",
    );
    await provider.markMessagesReadState([id], true);
    expect(folders.get("Sent")!.get(7)!.flags!.has("\\Seen")).toBe(true);
    expect(folders.get("INBOX")!.get(7)!.flags!.has("\\Seen")).toBe(false);
    validity = BigInt(2);
    await expect(provider.trashMessages([id])).rejects.toThrow(
      "mailbox changed",
    );
    expect(folders.get("Sent")!.has(7)).toBe(true);
  });
  it("hydrates an old thread across Inbox and Sent, using References rather than a recent-message cap", async () => {
    await addMessage("INBOX", 1, "<root@example.com>");
    await addMessage("Sent", 600, "<reply@example.com>", "<root@example.com>");
    const thread = await provider.getThread(
      buildThreadId(undefined, undefined, "<root@example.com>"),
    );
    expect(thread.messages).toHaveLength(2);
    expect(
      thread.messages.every(
        (message) => message.textPlain?.trim() === "Message body",
      ),
    ).toBe(true);
    expect(thread.messages[1].attachments?.[0].filename).toBe("file.txt");
    const attachment = await provider.getAttachment(thread.messages[1].id, "0");
    expect(Buffer.from(attachment.data, "base64").toString()).toBe("payload");
  });
  it("archives and undoes a move even though the destination UID changes", async () => {
    await addMessage("INBOX", 9, "<move@example.com>");
    const id = encodeMessageId(
      { path: "INBOX", uidValidity: BigInt(1) },
      9,
      "<move@example.com>",
    );
    await provider.archiveMessage(id);
    expect(folders.get("INBOX")!.size).toBe(0);
    expect(folders.get("Archive")!.size).toBe(1);
    await provider.unarchiveMessages([id]);
    expect(folders.get("Archive")!.size).toBe(0);
    expect(folders.get("INBOX")!.size).toBe(1);
  });
  it("honors structured inbox/unread queries and ends pagination for an empty folder", async () => {
    await addMessage("INBOX", 1, "<one@example.com>");
    await addMessage("INBOX", 2, "<two@example.com>");
    folders.get("INBOX")!.get(2)!.flags!.add("\\Seen");
    await addMessage("Sent", 3, "<three@example.com>");
    const result = await provider.getThreadsWithQuery({
      query: { type: "inbox", isUnread: true },
      maxResults: 20,
    });
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].messages[0].headers["message-id"]).toBe(
      "<one@example.com>",
    );
    expect(
      await provider.getThreadsWithQuery({ query: { type: "draft" } }),
    ).toEqual({ threads: [], nextPageToken: undefined });
  });
});

describe("IMAP draft lifecycle", () => {
  it("updates a stable draft reference and preserves attachments and Bcc on send", async () => {
    const created = await provider.createDraft({
      to: "you@example.com",
      subject: "Original",
      messageHtml: "<p>old</p>",
    });
    const original = await provider.getDraft(created.id);
    await provider.updateDraft(created.id, {
      subject: "Updated",
      messageHtml: "<p>new</p>",
      bcc: "hidden@example.com",
      attachments: [
        {
          filename: "binary.bin",
          content: "AP8=",
          contentType: "application/octet-stream",
        },
      ],
    });
    const updated = await provider.getDraft(created.id);
    expect(updated?.id).not.toBe(original?.id);
    expect(updated?.subject).toBe("Updated");
    expect(updated?.textHtml).toContain("new");
    expect(folders.get("Drafts")!.size).toBe(1);
    const reference = await provider.getDraftReferenceForMessage(updated!.id);
    expect(reference?.id).toBe(created.id);
    await provider.sendDraft(created.id);
    expect(mocks.send.mock.calls[0][1]).toMatchObject({
      subject: "Updated",
      bcc: "hidden@example.com",
      attachments: [{ filename: "binary.bin", content: Buffer.from([0, 255]) }],
    });
    expect(folders.get("Drafts")!.size).toBe(0);
    expect(mocks.processed).toHaveBeenCalledWith(
      expect.objectContaining({ processedStatus: "sent" }),
    );
  });
  it("retains the original draft when append fails and prevents a concurrent mutation", async () => {
    const created = await provider.createDraft({
      to: "you@example.com",
      subject: "Original",
      messageHtml: "old",
    });
    vi.mocked(
      mocks.client.append as ReturnType<typeof vi.fn>,
    ).mockRejectedValueOnce(new Error("disk full"));
    await expect(
      provider.updateDraft(created.id, { subject: "Changed" }),
    ).rejects.toThrow("disk full");
    expect((await provider.getDraft(created.id))?.subject).toBe("Original");
    mocks.acquire.mockResolvedValueOnce(null);
    await expect(provider.deleteDraft(created.id)).rejects.toThrow(
      "being changed",
    );
    expect(folders.get("Drafts")!.size).toBe(1);
  });
  it("does not remove a saved draft if SMTP fails", async () => {
    const created = await provider.createDraft({
      to: "you@example.com",
      subject: "Original",
      messageHtml: "old",
    });
    mocks.send.mockRejectedValueOnce(new Error("SMTP unavailable"));
    await expect(provider.sendDraft(created.id)).rejects.toThrow(
      "SMTP unavailable",
    );
    expect(folders.get("Drafts")!.size).toBe(1);
    expect(mocks.processed).not.toHaveBeenCalled();
  });
  it("refuses deletion using a superseded draft version", async () => {
    const created = await provider.createDraft({
      to: "you@example.com",
      subject: "Original",
      messageHtml: "old",
    });
    const version = (await provider.getDraft(created.id))!.id;
    await provider.updateDraft(created.id, { subject: "Updated" });
    expect(await provider.deleteDraft(created.id, version)).toBe(false);
    expect((await provider.getDraft(created.id))?.subject).toBe("Updated");
  });
});

async function addMessage(
  folder: string,
  uid: number,
  messageId: string,
  references?: string,
) {
  const source = await new MailComposer({
    from: "sender@example.com",
    to: "me@example.com",
    messageId,
    references,
    subject: "Message",
    text: "Message body",
    attachments: [{ filename: "file.txt", content: "payload" }],
  })
    .compile()
    .build();
  folders.get(folder)!.set(uid, {
    uid,
    source,
    flags: new Set(),
    envelope: {
      messageId,
      subject: "Message",
      date: new Date(2026, 0, uid),
      from: [{ address: "sender@example.com" }],
      to: [{ address: "me@example.com" }],
    },
  } as FetchMessageObject);
}
function matches(message: FetchMessageObject, criteria: SearchObject): boolean {
  if (criteria.not && matches(message, criteria.not)) return false;
  if (criteria.or && !criteria.or.some((part) => matches(message, part)))
    return false;
  if (
    criteria.seen !== undefined &&
    message.flags!.has("\\Seen") !== criteria.seen
  )
    return false;
  if (criteria.header)
    for (const [key, value] of Object.entries(criteria.header)) {
      const text = message.source!.toString();
      const line = text
        .split(/\r?\n/)
        .find((line) => line.toLowerCase().startsWith(`${key.toLowerCase()}:`));
      if (!line?.includes(String(value))) return false;
    }
  return true;
}
