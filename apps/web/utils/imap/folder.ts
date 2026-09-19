import type { ImapFlow, ListResponse } from "imapflow";
import type { EmailLabel } from "@/utils/email/types";
import type {
  OutlookFolder,
  OutlookSystemFolder,
} from "@/utils/outlook/folders";

export function folderSystemType(mailbox: {
  path: string;
  specialUse?: string;
}): OutlookSystemFolder | undefined {
  if (mailbox.path.toUpperCase() === "INBOX") return "INBOX";
  const types: Record<string, OutlookSystemFolder> = {
    "\\Sent": "SENT",
    "\\Drafts": "DRAFT",
    "\\Trash": "TRASH",
    "\\Junk": "SPAM",
    "\\Archive": "ARCHIVE",
  };
  if (mailbox.specialUse && types[mailbox.specialUse])
    return types[mailbox.specialUse];
  const names: Record<string, OutlookSystemFolder> = {
    sent: "SENT",
    "sent items": "SENT",
    "sent messages": "SENT",
    drafts: "DRAFT",
    draft: "DRAFT",
    trash: "TRASH",
    "deleted items": "TRASH",
    deleted: "TRASH",
    spam: "SPAM",
    junk: "SPAM",
    archive: "ARCHIVE",
  };
  return names[mailbox.path.toLowerCase()];
}

export async function selectableFolders(
  client: ImapFlow,
  includeAll = false,
): Promise<ListResponse[]> {
  return (await client.list()).filter(
    (mailbox) =>
      !mailbox.flags.has("\\Noselect") &&
      (includeAll || mailbox.specialUse !== "\\All"),
  );
}

export async function listFolders(client: ImapFlow): Promise<EmailLabel[]> {
  return (await selectableFolders(client, true)).map((mailbox) => ({
    id: mailbox.path,
    name: mailbox.name,
    type: folderSystemType(mailbox) ? "system" : "user",
    labelListVisibility: mailbox.listed ? "labelShow" : "labelHide",
    messageListVisibility: "show",
  }));
}

export async function listFoldersAsOutlookFolders(
  client: ImapFlow,
): Promise<OutlookFolder[]> {
  return (await selectableFolders(client, true)).map((mailbox) => ({
    id: mailbox.path,
    displayName: mailbox.name,
    childFolders: [],
    systemType: folderSystemType(mailbox),
  }));
}

export async function getOrCreateFolder(
  client: ImapFlow,
  folderName: string,
): Promise<string> {
  const existing = (await selectableFolders(client)).find(
    (mailbox) => mailbox.path.toLowerCase() === folderName.toLowerCase(),
  );
  if (existing) return existing.path;
  await client.mailboxCreate(folderName);
  return folderName;
}

export async function moveMessageToFolder(
  client: ImapFlow,
  uid: number,
  targetFolder: string,
): Promise<void> {
  const result = await client.messageMove(String(uid), targetFolder, {
    uid: true,
  });
  if (result === false) throw new Error("IMAP move failed");
}

export async function resolveFolder(
  client: ImapFlow,
  id: string,
): Promise<string> {
  if (id.toUpperCase() === "INBOX") return "INBOX";
  const folders = await selectableFolders(client, true);
  const exact = folders.find((folder) => folder.path === id);
  if (exact) return exact.path;
  const system = folders.find(
    (folder) => folderSystemType(folder) === (id === "DRAFTS" ? "DRAFT" : id),
  );
  if (system) return system.path;
  throw new Error("IMAP folder not found");
}

export async function findArchiveFolder(client: ImapFlow): Promise<string> {
  return findOrCreateSystemFolder(client, "ARCHIVE", "Archive");
}
export async function findTrashFolder(client: ImapFlow): Promise<string> {
  return findOrCreateSystemFolder(client, "TRASH", "Trash");
}
export async function findSentFolder(client: ImapFlow): Promise<string> {
  return findOrCreateSystemFolder(client, "SENT", "Sent");
}
export async function findDraftsFolder(client: ImapFlow): Promise<string> {
  return findOrCreateSystemFolder(client, "DRAFT", "Drafts");
}
export async function findJunkFolder(client: ImapFlow): Promise<string> {
  return findOrCreateSystemFolder(client, "SPAM", "Junk");
}
async function findOrCreateSystemFolder(
  client: ImapFlow,
  type: OutlookSystemFolder,
  name: string,
) {
  const folder = (await selectableFolders(client)).find(
    (mailbox) => folderSystemType(mailbox) === type,
  );
  if (folder) return folder.path;
  return getOrCreateFolder(client, name);
}
