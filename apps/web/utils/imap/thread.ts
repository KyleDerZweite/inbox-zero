export function buildThreadId(
  references: string | undefined,
  inReplyTo: string | undefined,
  messageId: string | undefined,
  fallbackId?: string,
): string {
  const root = getRootMessageId(references, inReplyTo, messageId);
  if (root) return `imap-thread:${Buffer.from(root).toString("base64url")}`;
  if (!fallbackId)
    throw new Error(
      "A message without threading headers needs a mailbox identity",
    );
  return `imap-single:${Buffer.from(fallbackId).toString("base64url")}`;
}

export function getRootMessageId(
  references: string | undefined,
  inReplyTo: string | undefined,
  messageId: string | undefined,
): string | undefined {
  for (const header of [references, inReplyTo, messageId]) {
    if (header) {
      const first = parseMessageIdList(header)[0];
      if (first) return first;
    }
  }
}

export function parseMessageIdList(header: string): string[] {
  const matches = [...header.matchAll(/<([^>]+)>/g)].map((match) =>
    match[1].trim(),
  );
  return matches.length
    ? matches
    : header
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter(Boolean);
}

export function getAllThreadMessageIds(
  references: string | undefined,
  inReplyTo: string | undefined,
  messageId: string | undefined,
): string[] {
  return [
    ...new Set(
      [references, inReplyTo, messageId].flatMap((header) =>
        header ? parseMessageIdList(header) : [],
      ),
    ),
  ];
}

export function decodeThreadId(
  id: string,
): { root: string } | { messageId: string } {
  if (id.startsWith("imap-thread:"))
    return { root: Buffer.from(id.slice(12), "base64url").toString() };
  if (id.startsWith("imap-single:"))
    return { messageId: Buffer.from(id.slice(12), "base64url").toString() };
  throw new Error("Invalid IMAP thread ID");
}
