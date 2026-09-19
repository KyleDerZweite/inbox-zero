import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import { findDraftsFolder } from "@/utils/imap/folder";
import { searchImapMessages } from "@/utils/imap/message";

export async function saveDraft(
  client: ImapFlow,
  options: Mail.Options,
): Promise<string> {
  const draftsFolder = await findDraftsFolder(client);
  const messageId = options.messageId || `<${randomUUID()}@inbox-zero.local>`;
  const mime = new MailComposer({
    ...options,
    messageId,
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  mime.keepBcc = true;
  const raw = await mime.build();
  const result = await client.append(
    draftsFolder,
    raw,
    ["\\Draft"],
    new Date(),
  );
  if (result === false) throw new Error("Saving IMAP draft failed");
  return draftIdFromMessageId(messageId);
}

export function draftIdFromMessageId(messageId: string): string {
  return `imap-draft:${Buffer.from(messageId).toString("base64url")}`;
}

export function draftMessageId(id: string): string {
  if (!id.startsWith("imap-draft:")) throw new Error("Invalid IMAP draft ID");
  const messageId = Buffer.from(id.slice(11), "base64url").toString();
  if (!/^<[^<>\r\n]+>$/.test(messageId))
    throw new Error("Invalid IMAP draft ID");
  return messageId;
}

export async function findDraftUids(
  client: ImapFlow,
  id: string,
  readOnly = true,
): Promise<number[]> {
  const messageId = draftMessageId(id);
  await client.mailboxOpen(await findDraftsFolder(client), { readOnly });
  const uids = await searchImapMessages(client, {
    header: { "Message-ID": messageId },
  });
  const exact: number[] = [];
  // Header SEARCH is a substring match. Never delete a similarly named draft.
  for (const uid of uids) {
    const message = await client.fetchOne(
      String(uid),
      { envelope: true },
      { uid: true },
    );
    if (message && message.envelope?.messageId === messageId) exact.push(uid);
  }
  return exact;
}
