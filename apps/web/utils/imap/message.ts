import type {
  ImapFlow,
  FetchMessageObject,
  MailboxObject,
  SearchObject,
} from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import type { ParsedMessage } from "@/utils/types";
import { buildThreadId } from "@/utils/imap/thread";
import { encodeMessageId } from "@/utils/imap/ids";
import { folderSystemType } from "@/utils/imap/folder";

export async function fetchMessageBySeq(
  client: ImapFlow,
  seq: number,
): Promise<ParsedMessage | null> {
  const msg = await client.fetchOne(String(seq), {
    uid: true,
    envelope: true,
    flags: true,
    source: true,
    internalDate: true,
  });
  return msg ? convertImapMessage(msg, selectedMailbox(client)) : null;
}

export async function fetchMessageByUid(
  client: ImapFlow,
  uid: number,
): Promise<ParsedMessage | null> {
  const msg = await client.fetchOne(
    String(uid),
    {
      uid: true,
      envelope: true,
      flags: true,
      source: true,
      internalDate: true,
    },
    { uid: true },
  );
  return msg ? convertImapMessage(msg, selectedMailbox(client)) : null;
}

export async function fetchRecentMessages(
  client: ImapFlow,
  mailbox: MailboxObject,
  maxResults: number,
): Promise<ParsedMessage[]> {
  if (!mailbox.exists) return [];
  const messages: ParsedMessage[] = [];
  for await (const msg of client.fetch(
    `${Math.max(1, mailbox.exists - maxResults + 1)}:${mailbox.exists}`,
    {
      uid: true,
      envelope: true,
      flags: true,
      headers: ["references", "list-unsubscribe", "list-unsubscribe-post"],
      internalDate: true,
    },
  )) {
    const parsed = await convertImapMessage(msg, mailbox);
    if (parsed) messages.push(parsed);
  }
  return messages.reverse();
}

export async function fetchMessagesByUids(
  client: ImapFlow,
  uids: number[],
  full = true,
): Promise<ParsedMessage[]> {
  if (!uids.length) return [];
  const mailbox = selectedMailbox(client);
  const messages: ParsedMessage[] = [];
  for await (const msg of client.fetch(
    uids.join(","),
    {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      ...(full ? { source: true } : { headers: ["references"] }),
    },
    { uid: true },
  )) {
    const parsed = await convertImapMessage(msg, mailbox);
    if (parsed) messages.push(parsed);
  }
  return messages.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
}

export async function readRawMessage(
  client: ImapFlow,
  uid: number,
): Promise<ParsedMail | null> {
  const msg = await client.fetchOne(
    String(uid),
    { source: true },
    { uid: true },
  );
  if (!msg) return null;
  if (!msg.source)
    throw new Error("IMAP server did not return the message source");
  return simpleParser(msg.source, {
    skipHtmlToText: true,
    skipImageLinks: true,
  });
}

export async function searchImapMessages(
  client: ImapFlow,
  criteria: SearchObject,
  maxResults?: number,
): Promise<number[]> {
  const found = await client.search(criteria, { uid: true });
  if (found === false) throw new Error("IMAP search failed");
  const uids = found.reverse();
  return maxResults === undefined ? uids : uids.slice(0, maxResults);
}

export async function convertImapMessage(
  msg: FetchMessageObject,
  mailbox: MailboxObject,
): Promise<ParsedMessage | null> {
  const envelope = msg.envelope;
  if (!envelope) return null;
  const parsed =
    msg.source || msg.headers
      ? await simpleParser(msg.source || msg.headers!, {
          skipHtmlToText: true,
          skipImageLinks: true,
        })
      : undefined;
  const references = Array.isArray(parsed?.references)
    ? parsed.references.join(" ")
    : parsed?.references;
  const messageId = parsed?.messageId || envelope.messageId;
  const inReplyTo = parsed?.inReplyTo || envelope.inReplyTo;
  const id = encodeMessageId(mailbox, msg.uid, messageId);
  const date = new Date(envelope.date || msg.internalDate || 0).toISOString();
  const formatAddresses = (addresses: typeof envelope.from) =>
    (addresses || [])
      .map((a) => (a.name ? `${a.name} <${a.address || ""}>` : a.address || ""))
      .join(", ");
  const flags = msg.flags || new Set<string>();
  const systemType = folderSystemType(mailbox);
  const labelIds = [
    ...new Set([
      mailbox.path,
      ...(systemType ? [systemType] : []),
      ...(!flags.has("\\Seen") ? ["UNREAD"] : []),
      ...(flags.has("\\Flagged") ? ["STARRED"] : []),
      ...(flags.has("\\Draft") ? ["DRAFT"] : []),
      ...[...flags].filter((flag) => !flag.startsWith("\\")),
    ]),
  ];
  const attachments = (parsed?.attachments || []).map((attachment, index) => ({
    attachmentId: String(index),
    filename: attachment.filename || "attachment",
    mimeType: attachment.contentType,
    size: attachment.size,
    headers: {
      "content-type": attachment.contentType,
      "content-description": "",
      "content-transfer-encoding": "base64",
      "content-id": attachment.contentId || "",
      "content-disposition": attachment.contentDisposition || "attachment",
    },
  }));
  return {
    id,
    threadId: buildThreadId(references, inReplyTo, messageId, id),
    historyId: `${mailbox.uidValidity}:${msg.uid}`,
    date,
    internalDate: String(new Date(msg.internalDate || date).getTime()),
    parentFolderId: mailbox.path,
    headers: {
      from: formatAddresses(envelope.from),
      to: formatAddresses(envelope.to),
      cc: formatAddresses(envelope.cc),
      bcc: formatAddresses(envelope.bcc),
      date,
      subject: envelope.subject || "",
      "message-id": messageId,
      "in-reply-to": inReplyTo,
      references,
      "reply-to": formatAddresses(envelope.replyTo),
      "list-unsubscribe": headerString(parsed, "list-unsubscribe"),
      "list-unsubscribe-post": headerString(parsed, "list-unsubscribe-post"),
    },
    subject: envelope.subject || "",
    snippet: (parsed?.text || envelope.subject || "")
      .slice(0, 200)
      .replace(/\s+/g, " "),
    textHtml: parsed?.html || undefined,
    textPlain: parsed?.text,
    labelIds,
    inline: attachments.filter(
      (attachment) => attachment.headers["content-disposition"] === "inline",
    ),
    attachments: attachments.filter(
      (attachment) => attachment.headers["content-disposition"] !== "inline",
    ),
  };
}

export function parseSearchQuery(query: string): SearchObject {
  const criteria: SearchObject[] = [];
  const parts = query.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const part of parts) {
    const separator = part.indexOf(":");
    const key = separator < 0 ? "" : part.slice(0, separator);
    const value = (separator < 0 ? part : part.slice(separator + 1)).replace(
      /^"|"$/g,
      "",
    );
    if (["from", "to", "subject"].includes(key))
      criteria.push({ [key]: value });
    else if (part === "is:unread") criteria.push({ seen: false });
    else if (part === "is:read") criteria.push({ seen: true });
    else if (part === "is:starred") criteria.push({ flagged: true });
    else if (["since", "after", "before"].includes(key)) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error("Invalid search date");
      criteria.push(key === "before" ? { before: date } : { since: date });
    } else if (key) throw new Error(`Unsupported IMAP search operator: ${key}`);
    else criteria.push({ text: value });
  }
  return combineSearchCriteria(criteria);
}

function selectedMailbox(client: ImapFlow): MailboxObject {
  if (!client.mailbox) throw new Error("No IMAP mailbox selected");
  return client.mailbox;
}

function headerString(
  mail: ParsedMail | undefined,
  name: string,
): string | undefined {
  const value = mail?.headers.get(name);
  if (typeof value === "string") return value;
  const raw = mail?.headerLines.find((header) => header.key === name)?.line;
  return raw
    ?.slice(raw.indexOf(":") + 1)
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();
}

export function combineSearchCriteria(criteria: SearchObject[]): SearchObject {
  if (!criteria.length) return { all: true };
  if (criteria.length === 1) return criteria[0];
  // ImapFlow exposes OR and NOT, but no explicit AND for repeated criteria.
  return { not: { or: criteria.map((criterion) => ({ not: criterion })) } };
}
