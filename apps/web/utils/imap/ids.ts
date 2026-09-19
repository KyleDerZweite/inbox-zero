import type { ImapFlow, MailboxObject } from "imapflow";

export function encodeMessageId(
  mailbox: Pick<MailboxObject, "path" | "uidValidity">,
  uid: number,
  rfcMessageId?: string,
): string {
  return `imap:${Buffer.from(JSON.stringify([mailbox.path, String(mailbox.uidValidity), uid, rfcMessageId])).toString("base64url")}`;
}

export function decodeMessageId(id: string) {
  if (!id.startsWith("imap:")) throw new Error("Invalid IMAP message ID");
  const value: unknown = JSON.parse(
    Buffer.from(id.slice(5), "base64url").toString(),
  );
  if (
    !Array.isArray(value) ||
    typeof value[0] !== "string" ||
    !value[0] ||
    typeof value[1] !== "string" ||
    !/^\d+$/.test(value[1]) ||
    !Number.isSafeInteger(value[2]) ||
    value[2] <= 0 ||
    (value[3] != null && typeof value[3] !== "string")
  ) {
    throw new Error("Invalid IMAP message ID");
  }
  return {
    folder: value[0] as string,
    uidValidity: value[1] as string,
    uid: value[2] as number,
    rfcMessageId: value[3] as string | undefined,
  };
}

export async function openMessageMailbox(
  client: ImapFlow,
  id: string,
  readOnly = true,
) {
  const identity = decodeMessageId(id);
  const mailbox = await client.mailboxOpen(identity.folder, { readOnly });
  if (String(mailbox.uidValidity) !== identity.uidValidity)
    throw new Error(
      "IMAP mailbox changed. Refresh before acting on this message.",
    );
  return identity;
}
