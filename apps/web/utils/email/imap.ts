import type { ImapFlow, SearchObject } from "imapflow";
import type { ParsedMail } from "mailparser";
import type Mail from "nodemailer/lib/mailer";
import type {
  EmailProvider,
  EmailThread,
  EmailLabelUpdate,
  MailboxSyncPage,
  BulkArchiveThread,
  BulkArchiveResult,
} from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import type { ImapCredentialConfig } from "@/utils/imap/types";
import type { InboxZeroLabel } from "@/utils/label";
import type { Logger } from "@/utils/logger";
import type { LocalMailSyncResponse } from "@/utils/email/local-mail-sync-types";
import { UnsupportedImapOperationError } from "@/utils/imap/types";
import { withImapConnection } from "@/utils/imap/client";
import {
  fetchMessageByUid,
  fetchMessagesByUids,
  combineSearchCriteria,
  parseSearchQuery,
  readRawMessage,
  searchImapMessages,
} from "@/utils/imap/message";
import { decodeMessageId, openMessageMailbox } from "@/utils/imap/ids";
import {
  findArchiveFolder,
  findTrashFolder,
  findJunkFolder,
  folderSystemType,
  getOrCreateFolder,
  listFolders,
  listFoldersAsOutlookFolders,
  moveMessageToFolder,
  resolveFolder,
  selectableFolders,
} from "@/utils/imap/folder";
import {
  saveDraft,
  draftIdFromMessageId,
  draftMessageId,
  findDraftUids,
} from "@/utils/imap/draft";
import { sendSmtpEmail } from "@/utils/imap/mail";
import {
  buildThreadId,
  decodeThreadId,
  parseMessageIdList,
} from "@/utils/imap/thread";
import { toMailerAttachments } from "@/utils/types/mail";
import {
  acquireOwnedLock,
  clearOwnedLock,
  markOwnedLockProcessed,
} from "@/utils/redis/owned-lock";

export class ImapProvider implements EmailProvider {
  readonly name = "imap" as const;
  readonly localMailSyncStrategy = "folder-delta" as const;

  private readonly config: ImapCredentialConfig;

  constructor(config: ImapCredentialConfig, _logger?: Logger) {
    this.config = config;
  }

  private withConnection<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return withImapConnection(this.config, fn);
  }

  toJSON() {
    return { name: this.name, type: this.name };
  }
  getAccessToken() {
    return "";
  }

  async getMessage(id: string): Promise<ParsedMessage> {
    return this.withConnection(async (client) => {
      const { uid } = await openMessageMailbox(client, id);
      const message = await fetchMessageByUid(client, uid);
      if (!message)
        throw new Error("IMAP message no longer exists. Refresh the mailbox.");
      return message;
    });
  }

  async getMessageByRfc822MessageId(id: string): Promise<ParsedMessage | null> {
    return this.withConnection(async (client) => {
      for (const folder of await selectableFolders(client)) {
        await client.mailboxOpen(folder.path, { readOnly: true });
        const messages = await fetchMessagesByUids(
          client,
          await searchImapMessages(client, { header: { "Message-ID": id } }),
        );
        const match = messages.find((message) =>
          sameRfcId(message.headers["message-id"], id),
        );
        if (match) return match;
      }
      return null;
    });
  }

  async getMessagesBatch(ids: string[]) {
    const messages: ParsedMessage[] = [];
    for (const id of ids) messages.push(await this.getMessage(id));
    return messages;
  }

  async getInboxMessages(maxResults = 50) {
    return (await this.listMessages({ folder: "INBOX", maxResults })).messages;
  }

  async getInboxStats() {
    return this.withConnection(async (client) => {
      const status = await client.status("INBOX", {
        messages: true,
        unseen: true,
      });
      return { total: status.messages || 0, unread: status.unseen || 0 };
    });
  }

  private async listMessages(options: {
    folder?: string;
    criteria?: SearchObject;
    maxResults?: number;
    pageToken?: string;
    full?: boolean;
  }) {
    const limit = Math.min(100, Math.max(1, options.maxResults ?? 20));
    const offset = options.pageToken ? Number(options.pageToken) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid IMAP page token");
    return this.withConnection(async (client) => {
      const folders = options.folder
        ? [await resolveFolder(client, options.folder)]
        : (await selectableFolders(client)).map((folder) => folder.path);
      let position = 0;
      const messages: ParsedMessage[] = [];
      let hasMore = false;
      for (const folder of folders) {
        await client.mailboxOpen(folder, { readOnly: true });
        const uids = await searchImapMessages(
          client,
          options.criteria || { all: true },
        );
        const page = uids.slice(
          Math.max(0, offset - position),
          Math.max(0, offset + limit - position),
        );
        messages.push(
          ...(await fetchMessagesByUids(client, page, options.full !== false)),
        );
        position += uids.length;
        if (position > offset + limit) {
          hasMore = true;
          break;
        }
      }
      return {
        messages,
        nextPageToken: hasMore ? String(offset + limit) : undefined,
      };
    });
  }

  async getMessagesWithPagination(
    options: Parameters<EmailProvider["getMessagesWithPagination"]>[0],
  ) {
    return this.listMessages({
      folder: options.inboxOnly ? "INBOX" : undefined,
      maxResults: options.maxResults,
      pageToken: options.pageToken,
      criteria: combineSearchCriteria([
        parseSearchQuery(options.query || ""),
        ...(options.before ? [{ before: options.before }] : []),
        ...(options.after ? [{ since: options.after }] : []),
        ...(options.unreadOnly ? [{ seen: false }] : []),
      ]),
    });
  }

  async searchMessages(
    options: Parameters<EmailProvider["searchMessages"]>[0],
  ) {
    return this.listMessages({
      folder: options.labelName,
      maxResults: options.maxResults,
      pageToken: options.pageToken,
      criteria: combineSearchCriteria([
        parseSearchQuery(options.query),
        ...(options.fromEmail ? [{ from: options.fromEmail }] : []),
        ...(options.readState ? [{ seen: options.readState === "read" }] : []),
      ]),
    });
  }

  async getMessagesFromSender(
    options: Parameters<EmailProvider["getMessagesFromSender"]>[0],
  ) {
    return this.listMessages({
      maxResults: options.maxResults,
      pageToken: options.pageToken,
      criteria: {
        from: options.senderEmail,
        before: options.before,
        since: options.after,
      },
    });
  }

  async getMessagesWithAttachments(
    options: Parameters<EmailProvider["getMessagesWithAttachments"]>[0],
  ) {
    const page = await this.listMessages(options);
    return {
      ...page,
      messages: page.messages.filter(
        (message) => message.attachments?.length || message.inline.length,
      ),
    };
  }

  async getThread(
    id: string,
    options?: Parameters<EmailProvider["getThread"]>[1],
  ): Promise<EmailThread> {
    options?.signal?.throwIfAborted();
    const messages = await this.threadMessages(id, options?.includeDrafts);
    options?.signal?.throwIfAborted();
    if (!messages.length) throw new Error("IMAP thread not found");
    return { id, messages, snippet: messages.at(-1)?.snippet || "" };
  }

  private async threadMessages(id: string, includeDrafts = false) {
    const identity = decodeThreadId(id);
    if ("messageId" in identity) {
      const message = await this.getMessage(identity.messageId);
      return includeDrafts || !message.labelIds?.includes("DRAFT")
        ? [message]
        : [];
    }
    return this.withConnection(async (client) => {
      const messages: ParsedMessage[] = [];
      for (const folder of await selectableFolders(client)) {
        if (!includeDrafts && folderSystemType(folder) === "DRAFT") continue;
        await client.mailboxOpen(folder.path, { readOnly: true });
        const uids = await searchImapMessages(client, {
          or: [
            { header: { "Message-ID": identity.root } },
            { header: { References: identity.root } },
            { header: { "In-Reply-To": identity.root } },
          ],
        });
        const matches = await fetchMessagesByUids(client, uids);
        messages.push(
          ...matches.filter(
            (message) =>
              message.threadId === id &&
              (includeDrafts || !message.labelIds?.includes("DRAFT")),
          ),
        );
      }
      return messages.sort(chronological);
    });
  }

  async getThreadMessages(id: string) {
    return this.threadMessages(id);
  }
  async getThreadMessagesInInbox(id: string) {
    return (await this.threadMessages(id)).filter((message) =>
      message.labelIds?.includes("INBOX"),
    );
  }
  async getThreads(folderId = "INBOX") {
    return groupThreads(
      (await this.listMessages({ folder: folderId, maxResults: 50 })).messages,
    );
  }

  async getThreadsWithQuery(
    options: Parameters<EmailProvider["getThreadsWithQuery"]>[0],
  ) {
    const query = options.query || {};
    if (
      query.anyOf?.length ||
      query.anyLabelIds?.length ||
      query.excludeLabelNames?.length ||
      query.excludeSplits?.length ||
      query.inboxSection ||
      (query.labelIds?.length || 0) > 1
    )
      throw new UnsupportedImapOperationError("advanced split queries");
    const systemFolders: Record<string, string> = {
      inbox: "INBOX",
      sent: "SENT",
      draft: "DRAFT",
      drafts: "DRAFT",
      trash: "TRASH",
      spam: "SPAM",
      archive: "ARCHIVE",
    };
    const folder =
      query.folderId ||
      query.labelId ||
      query.labelIds?.[0] ||
      (query.type ? systemFolders[query.type] : query.q ? undefined : "INBOX");
    if (
      query.type &&
      !systemFolders[query.type] &&
      !["all", "starred", "unread", "search"].includes(query.type)
    )
      throw new UnsupportedImapOperationError(`thread type ${query.type}`);
    const page = await this.listMessages({
      folder,
      maxResults: options.maxResults || query.limit || undefined,
      pageToken: options.pageToken,
      full: options.messageFormat !== "metadata",
      criteria: combineSearchCriteria([
        parseSearchQuery(query.q || ""),
        ...(query.fromEmail ? [{ from: query.fromEmail }] : []),
        ...(query.after ? [{ since: query.after }] : []),
        ...(query.before ? [{ before: query.before }] : []),
        ...(query.isUnread || query.type === "unread" ? [{ seen: false }] : []),
        ...(query.type === "starred" ? [{ flagged: true }] : []),
      ]),
    });
    return {
      threads: groupThreads(page.messages),
      nextPageToken: page.nextPageToken,
    };
  }

  async searchThreads(options: Parameters<EmailProvider["searchThreads"]>[0]) {
    return this.getThreadsWithQuery({
      ...options,
      query: { q: options.query },
    });
  }
  async getThreadsWithLabel(
    options: Parameters<EmailProvider["getThreadsWithLabel"]>[0],
  ) {
    return groupThreads(
      (
        await this.listMessages({
          folder: options.labelId,
          maxResults: options.maxResults,
        })
      ).messages,
    );
  }
  async getThreadsWithParticipant(
    options: Parameters<EmailProvider["getThreadsWithParticipant"]>[0],
  ) {
    return groupThreads(
      (
        await this.listMessages({
          maxResults: options.maxThreads,
          criteria: {
            or: [
              { from: options.participantEmail },
              { to: options.participantEmail },
              { cc: options.participantEmail },
            ],
          },
        })
      ).messages,
    );
  }
  async getThreadsFromSenderWithSubject(sender: string, limit: number) {
    return groupThreads(
      (
        await this.getMessagesFromSender({
          senderEmail: sender,
          maxResults: limit,
        })
      ).messages,
    ).map((thread) => ({
      id: thread.id,
      snippet: thread.snippet,
      subject: thread.messages.at(-1)?.subject || "",
    }));
  }
  async getLatestMessageInThread(id: string) {
    return (await this.getThreadMessages(id)).at(-1) || null;
  }
  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ) {
    const last = [...thread.messages].sort(chronological).at(-1);
    return last
      ? this.getMessage(last.id)
      : this.getLatestMessageInThread(thread.id);
  }
  async getPreviousConversationMessages(ids: string[]) {
    return this.getMessagesBatch(ids);
  }

  async getLabels() {
    return this.withConnection(listFolders);
  }
  async getLabelById(id: string) {
    return (await this.getLabels()).find((label) => label.id === id) || null;
  }
  async getLabelByName(name: string) {
    return (
      (await this.getLabels()).find(
        (label) => label.name.toLowerCase() === name.toLowerCase(),
      ) || null
    );
  }
  async getOrCreateInboxZeroLabel(key: InboxZeroLabel) {
    const name = `InboxZero/${key}`;
    const id = await this.getOrCreateFolderIdByName(name);
    return { id, name, type: "user" };
  }
  async createLabel(name: string) {
    return this.withConnection(async (client) => {
      await client.mailboxCreate(name);
      return { id: name, name, type: "user" };
    });
  }
  async deleteLabel(id: string) {
    return this.deleteFolder(id);
  }
  async updateLabel(id: string, update: EmailLabelUpdate) {
    if (
      update.color ||
      update.labelListVisibility ||
      update.messageListVisibility
    )
      throw new UnsupportedImapOperationError("label appearance");
    if (update.name) await this.renameFolder(id, update.name);
  }
  async labelMessage(options: Parameters<EmailProvider["labelMessage"]>[0]) {
    await this.moveMessages([options.messageId], options.labelId);
    return { actualLabelId: options.labelId };
  }
  async removeThreadLabel(_id: string, _label: string): Promise<void> {
    throw new UnsupportedImapOperationError("removeThreadLabel");
  }
  async removeThreadLabels(_id: string, _labels: string[]): Promise<void> {
    throw new UnsupportedImapOperationError("removeThreadLabels");
  }

  private async moveMessages(
    ids: string[],
    destination: string | ((client: ImapFlow) => Promise<string>),
  ) {
    return this.withConnection(async (client) => {
      const target =
        typeof destination === "string"
          ? await resolveFolder(client, destination)
          : await destination(client);
      for (const id of ids) {
        const identity = await openMessageMailbox(client, id, false);
        if (identity.folder === target) continue;
        if (
          !(await client.fetchOne(
            String(identity.uid),
            { uid: true },
            { uid: true },
          ))
        )
          throw new Error("IMAP message no longer exists");
        await moveMessageToFolder(client, identity.uid, target);
      }
    });
  }
  async archiveMessages(ids: string[], labelId?: string) {
    return this.moveMessages(ids, labelId || findArchiveFolder);
  }
  async archiveMessage(id: string) {
    return this.archiveMessages([id]);
  }
  async archiveThread(id: string, _owner: string) {
    return this.archiveMessages(
      (await this.getThreadMessagesInInbox(id)).map((message) => message.id),
    );
  }
  async archiveThreadWithLabel(id: string, _owner: string, labelId?: string) {
    return this.archiveMessages(
      (await this.getThreadMessagesInInbox(id)).map((message) => message.id),
      labelId,
    );
  }
  async trashMessages(ids: string[]) {
    return this.moveMessages(ids, findTrashFolder);
  }
  async trashThread(
    id: string,
    _owner: string,
    _source: "user" | "automation",
  ) {
    return this.trashMessages(
      (await this.getThreadMessages(id)).map((message) => message.id),
    );
  }
  async moveThreadToFolder(id: string, _owner: string, folder: string) {
    const target = await this.getOrCreateFolderIdByName(folder);
    return this.moveMessages(
      (await this.getThreadMessages(id)).map((message) => message.id),
      target,
    );
  }
  async markSpam(id: string) {
    return this.moveMessages(
      (await this.getThreadMessages(id)).map((message) => message.id),
      findJunkFolder,
    );
  }

  private async flagMessages(ids: string[], flag: string, enabled: boolean) {
    return this.withConnection(async (client) => {
      for (const id of ids) {
        const { uid } = await openMessageMailbox(client, id, false);
        if (!(await client.fetchOne(String(uid), { uid: true }, { uid: true })))
          throw new Error("IMAP message no longer exists");
        const result = enabled
          ? await client.messageFlagsAdd(String(uid), [flag], { uid: true })
          : await client.messageFlagsRemove(String(uid), [flag], { uid: true });
        if (!result) throw new Error("IMAP flag update failed");
      }
    });
  }
  async markMessagesReadState(ids: string[], read: boolean) {
    return this.flagMessages(ids, "\\Seen", read);
  }
  async markMessagesStarredState(ids: string[], starred: boolean) {
    return this.flagMessages(ids, "\\Flagged", starred);
  }
  async starMessage(id: string) {
    return this.markMessagesStarredState([id], true);
  }
  async markReadThread(id: string, read: boolean) {
    return this.markMessagesReadState(
      (await this.getThreadMessages(id)).map((message) => message.id),
      read,
    );
  }
  async markRead(id: string) {
    return this.markReadThread(id, true);
  }

  private async restoreMessages(ids: string[], source: "ARCHIVE" | "TRASH") {
    return this.withConnection(async (client) => {
      const sourceFolder = await resolveFolder(client, source);
      for (const id of ids) {
        const identity = decodeMessageId(id);
        if (identity.folder === sourceFolder) {
          await openMessageMailbox(client, id, false);
          if (
            !(await client.fetchOne(
              String(identity.uid),
              { uid: true },
              { uid: true },
            ))
          )
            throw new Error("IMAP message no longer exists");
          await moveMessageToFolder(client, identity.uid, "INBOX");
          continue;
        }
        // MOVE assigns a new UID. Resolve the original RFC identity in the destination for undo.
        if (!identity.rfcMessageId)
          throw new UnsupportedImapOperationError(
            "undo a moved message without Message-ID",
          );
        await client.mailboxOpen(sourceFolder);
        const candidates = await fetchMessagesByUids(
          client,
          await searchImapMessages(client, {
            header: { "Message-ID": identity.rfcMessageId },
          }),
          false,
        );
        const matches = candidates.filter((message) =>
          sameRfcId(message.headers["message-id"], identity.rfcMessageId),
        );
        if (matches.length !== 1)
          throw new Error("Cannot uniquely locate the moved IMAP message");
        await moveMessageToFolder(
          client,
          decodeMessageId(matches[0].id).uid,
          "INBOX",
        );
      }
    });
  }
  async unarchiveMessages(ids: string[]) {
    return this.restoreMessages(ids, "ARCHIVE");
  }
  async untrashMessages(ids: string[]) {
    return this.restoreMessages(ids, "TRASH");
  }
  async unarchiveThread(id: string) {
    return this.unarchiveMessages(
      (await this.getThreadMessages(id))
        .filter((message) => message.labelIds?.includes("ARCHIVE"))
        .map((message) => message.id),
    );
  }
  async untrashThread(id: string) {
    return this.untrashMessages(
      (await this.getThreadMessages(id))
        .filter((message) => message.labelIds?.includes("TRASH"))
        .map((message) => message.id),
    );
  }
  async bulkArchiveThreads(
    threads: BulkArchiveThread[],
    _owner: string,
  ): Promise<BulkArchiveResult> {
    const result: BulkArchiveResult = {
      succeededThreadIds: [],
      failedThreadIds: [],
    };
    for (const thread of threads) {
      try {
        await this.archiveMessages(thread.messageIds);
        result.succeededThreadIds.push(thread.threadId);
      } catch {
        result.failedThreadIds.push(thread.threadId);
      }
    }
    return result;
  }
  async bulkArchiveFromSenders(
    senders: string[],
    _owner: string,
    _account: string,
  ) {
    return this.moveFromSenders(senders, findArchiveFolder);
  }
  async bulkTrashFromSenders(
    senders: string[],
    _owner: string,
    _account: string,
  ) {
    return this.moveFromSenders(senders, findTrashFolder);
  }
  private async moveFromSenders(
    senders: string[],
    destination: (client: ImapFlow) => Promise<string>,
  ) {
    if (!senders.length) return;
    return this.withConnection(async (client) => {
      const target = await destination(client);
      await client.mailboxOpen("INBOX");
      const uids = await searchImapMessages(client, {
        or: senders.map((from) => ({ from })),
      });
      for (const uid of uids) await moveMessageToFolder(client, uid, target);
    });
  }

  async sendEmail(args: Parameters<EmailProvider["sendEmail"]>[0]) {
    return sendSmtpEmail(this.config, { ...args, text: args.messageText });
  }
  async sendEmailWithHtml(
    body: Parameters<EmailProvider["sendEmailWithHtml"]>[0],
  ) {
    if (body.providerDraftId) {
      await this.updateDraft(body.providerDraftId, body);
      return this.sendDraft(body.providerDraftId);
    }
    const result = await sendSmtpEmail(this.config, {
      ...body,
      html: body.messageHtml,
      attachments: toMailerAttachments(body.attachments),
      inReplyTo: body.replyToEmail?.headerMessageId,
      references: replyReferences(
        body.replyToEmail?.references,
        body.replyToEmail?.headerMessageId,
      ),
    });
    return {
      ...result,
      threadId:
        body.replyToEmail?.threadId ||
        buildThreadId(undefined, undefined, result.messageId),
    };
  }
  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options?: Parameters<EmailProvider["replyToEmail"]>[2],
  ) {
    return sendSmtpEmail(this.config, {
      to: email.headers["reply-to"] || email.headers.from,
      from: options?.from,
      replyTo: options?.replyTo,
      attachments: options?.attachments,
      subject: /^re:/i.test(email.subject)
        ? email.subject
        : `Re: ${email.subject}`,
      html: content,
      inReplyTo: email.headers["message-id"],
      references: replyReferences(
        email.headers.references,
        email.headers["message-id"],
      ),
    });
  }
  async forwardEmail(
    email: ParsedMessage,
    args: Parameters<EmailProvider["forwardEmail"]>[1],
  ) {
    const attachments = await this.mailAttachments(email.id);
    return sendSmtpEmail(this.config, {
      ...args,
      subject: /^fwd:/i.test(email.subject)
        ? email.subject
        : `Fwd: ${email.subject}`,
      html: `${args.content || ""}<br><br>${email.textHtml || escapeHtml(email.textPlain || "")}`,
      attachments,
    });
  }

  async getDrafts(options?: { maxResults?: number }) {
    return (
      await this.listMessages({
        folder: "DRAFT",
        maxResults: options?.maxResults,
      })
    ).messages;
  }
  async getDraft(id: string) {
    return this.withConnection(async (client) => {
      const [uid] = await findDraftUids(client, id);
      return uid ? fetchMessageByUid(client, uid) : null;
    });
  }
  async getDraftReferenceForMessage(id: string) {
    const message = await this.getMessage(id);
    if (!message.labelIds?.includes("DRAFT") || !message.headers["message-id"])
      return null;
    return {
      id: draftIdFromMessageId(message.headers["message-id"]),
      version: message.id,
    };
  }
  async createDraft(params: Parameters<EmailProvider["createDraft"]>[0]) {
    const reply = params.replyToMessageId
      ? await this.getMessage(params.replyToMessageId)
      : undefined;
    return this.withConnection(async (client) => ({
      id: await saveDraft(client, {
        from: this.config.email,
        to: params.to,
        subject: params.subject,
        html: params.messageHtml,
        inReplyTo: reply?.headers["message-id"],
        references: replyReferences(
          reply?.headers.references,
          reply?.headers["message-id"],
        ),
      }),
    }));
  }
  async draftEmail(
    email: ParsedMessage,
    args: Parameters<EmailProvider["draftEmail"]>[1],
    userEmail: string,
  ) {
    return this.withConnection(async (client) => ({
      draftId: await saveDraft(client, {
        from: userEmail,
        to: args.to || email.headers["reply-to"] || email.headers.from,
        cc: args.cc,
        bcc: args.bcc,
        subject:
          args.subject ||
          (/^re:/i.test(email.subject)
            ? email.subject
            : `Re: ${email.subject}`),
        html: args.content,
        attachments: args.attachments,
        inReplyTo: email.headers["message-id"],
        references: replyReferences(
          email.headers.references,
          email.headers["message-id"],
        ),
      }),
    }));
  }
  private async withDraftLock<T>(
    id: string,
    fn: (key: string, token: string) => Promise<T>,
  ): Promise<T> {
    draftMessageId(id);
    const key = `imap-draft:${this.config.emailAccountId}:${id}`;
    const token = await acquireOwnedLock({ key, processingTtlSeconds: 300 });
    if (!token)
      throw new Error(
        "This draft is being changed or has already been sent. Refresh and try again.",
      );
    try {
      return await fn(key, token);
    } finally {
      await clearOwnedLock({ key, lockToken: token });
    }
  }
  async updateDraft(
    id: string,
    params: Parameters<EmailProvider["updateDraft"]>[1],
  ) {
    return this.withDraftLock(id, () =>
      this.withConnection(async (client) => {
        const oldUids = await findDraftUids(client, id, false);
        if (!oldUids.length) throw new Error("Draft not found");
        const original = await readRawMessage(client, oldUids[0]);
        if (!original) throw new Error("Draft not found");
        await saveDraft(client, {
          ...mailOptions(original),
          messageId: draftMessageId(id),
          to: params.to ?? addressText(original.to),
          cc: params.cc ?? addressText(original.cc),
          bcc: params.bcc ?? addressText(original.bcc),
          subject: params.subject ?? original.subject,
          html: params.messageHtml ?? (original.html || undefined),
          text: params.messageHtml === undefined ? original.text : undefined,
          attachments:
            params.attachments === undefined
              ? parsedAttachments(original)
              : toMailerAttachments(params.attachments),
        });
        // The old version remains available if APPEND fails.
        if (!(await client.messageDelete(oldUids.join(","), { uid: true })))
          throw new Error(
            "Saved draft, but could not remove its previous version",
          );
      }),
    );
  }
  async deleteDraft(id: string, version?: string) {
    return this.withDraftLock(id, () =>
      this.withConnection(async (client) => {
        const uids = await findDraftUids(client, id, false);
        if (!uids.length) return false;
        if (version) {
          const identity = decodeMessageId(version);
          if (
            !client.mailbox ||
            client.mailbox.path !== identity.folder ||
            String(client.mailbox.uidValidity) !== identity.uidValidity ||
            uids[0] !== identity.uid
          )
            return false;
        }
        return client.messageDelete(uids.join(","), { uid: true });
      }),
    );
  }
  async sendDraft(id: string) {
    return this.withDraftLock(id, (key, token) =>
      this.withConnection(async (client) => {
        const uids = await findDraftUids(client, id, false);
        if (!uids.length) throw new Error("Draft not found");
        const mail = await readRawMessage(client, uids[0]);
        if (!mail) throw new Error("Draft not found");
        const result = await sendSmtpEmail(this.config, {
          ...mailOptions(mail),
          to: addressText(mail.to),
          subject: mail.subject || "",
          messageId: draftMessageId(id),
        });
        // Keep a sent marker so a failed IMAP cleanup cannot trigger a duplicate SMTP send.
        try {
          const recorded = await markOwnedLockProcessed({
            key,
            lockToken: token,
            processedStatus: "sent",
            processedTtlSeconds: 604_800,
          });
          if (!recorded) throw new Error("Could not record sent status");
          if (!(await client.messageDelete(uids.join(","), { uid: true })))
            throw new Error("Could not remove the sent draft");
        } catch (cause) {
          throw new Error(
            "Email sent, but recording completion or removing the IMAP draft failed. Do not resend.",
            { cause },
          );
        }
        return {
          ...result,
          threadId: buildThreadId(
            Array.isArray(mail.references)
              ? mail.references.join(" ")
              : mail.references,
            mail.inReplyTo,
            result.messageId,
          ),
        };
      }),
    );
  }

  async getFolders() {
    return this.withConnection(listFoldersAsOutlookFolders);
  }
  async getFolderCounts() {
    return this.withConnection(async (client) => {
      const counts = [];
      for (const folder of await selectableFolders(client)) {
        const status = await client.status(folder.path, {
          messages: true,
          unseen: true,
        });
        counts.push({
          id: folder.path,
          name: folder.name,
          total: status.messages || 0,
          unread: status.unseen || 0,
          systemType: folderSystemType(folder),
        });
      }
      return counts;
    });
  }
  async getOrCreateFolderIdByName(name: string) {
    return this.withConnection((client) => getOrCreateFolder(client, name));
  }
  async deleteFolder(id: string) {
    await this.withConnection((client) => client.mailboxDelete(id));
  }
  async renameFolder(id: string, name: string) {
    await this.withConnection((client) => client.mailboxRename(id, name));
  }
  async getFiltersList() {
    return [];
  }
  async createFilter(): Promise<{ status: number }> {
    throw new UnsupportedImapOperationError("createFilter");
  }
  async createAutoArchiveFilter(): Promise<{ status: number }> {
    throw new UnsupportedImapOperationError("createAutoArchiveFilter");
  }
  async deleteFilter(): Promise<{ status: number }> {
    throw new UnsupportedImapOperationError("deleteFilter");
  }
  async blockUnsubscribedEmail(): Promise<void> {
    throw new UnsupportedImapOperationError("blockUnsubscribedEmail");
  }
  async getSignatures() {
    return [];
  }
  async searchContacts(): Promise<never> {
    throw new UnsupportedImapOperationError("searchContacts");
  }

  private async mailAttachments(id: string): Promise<Mail.Attachment[]> {
    return this.withConnection(async (client) => {
      const { uid } = await openMessageMailbox(client, id);
      const mail = await readRawMessage(client, uid);
      if (!mail) throw new Error("Message not found");
      return parsedAttachments(mail);
    });
  }
  async getAttachment(id: string, attachmentId: string) {
    const attachments = await this.mailAttachments(id);
    if (!/^(0|[1-9]\d*)$/.test(attachmentId))
      throw new Error("Invalid attachment ID");
    const content = attachments[Number(attachmentId)]?.content;
    if (!Buffer.isBuffer(content)) throw new Error("Attachment not found");
    return { data: content.toString("base64"), size: content.length };
  }
  async getAttachmentStream(
    id: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    signal?.throwIfAborted();
    const attachment = await this.getAttachment(id, attachmentId);
    signal?.throwIfAborted();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(attachment.data, "base64"));
        controller.close();
      },
    });
  }
  async getOriginalMessage(id: string | undefined) {
    return id ? this.getMessage(id) : null;
  }
  async getSentMessages(maxResults = 50) {
    return (await this.listMessages({ folder: "SENT", maxResults })).messages;
  }
  async getSentMessageIds(
    options: Parameters<EmailProvider["getSentMessageIds"]>[0],
  ) {
    const page = await this.listMessages({
      folder: "SENT",
      maxResults: options.maxResults,
      pageToken: options.pageToken,
      criteria: { before: options.before, since: options.after },
      full: false,
    });
    return {
      ...page,
      messages: page.messages.map(({ id, threadId }) => ({ id, threadId })),
    };
  }
  async getSentThreadsExcluding(
    options: Parameters<EmailProvider["getSentThreadsExcluding"]>[0],
  ) {
    return groupThreads(
      (
        await this.listMessages({
          folder: "SENT",
          maxResults: options.maxResults,
          criteria: combineSearchCriteria([
            ...(options.excludeToEmails || []).map((to) => ({ not: { to } })),
            ...(options.excludeFromEmails || []).map((from) => ({
              not: { from },
            })),
          ]),
        })
      ).messages,
    );
  }
  async checkIfReplySent(sender: string) {
    return (
      (
        await this.listMessages({
          folder: "SENT",
          maxResults: 1,
          criteria: { to: sender },
        })
      ).messages.length > 0
    );
  }
  async countReceivedMessages(sender: string, threshold: number) {
    return this.withConnection(async (client) => {
      await client.mailboxOpen("INBOX", { readOnly: true });
      return (await searchImapMessages(client, { from: sender }, threshold))
        .length;
    });
  }
  async hasPreviousCommunicationsWithSenderOrDomain(
    options: Parameters<
      EmailProvider["hasPreviousCommunicationsWithSenderOrDomain"]
    >[0],
  ) {
    const address = options.from.match(/<([^>]+)>/)?.[1] || options.from;
    return (
      (
        await this.listMessages({
          folder: "SENT",
          maxResults: 1,
          criteria: { to: address, before: options.date },
        })
      ).messages.length > 0
    );
  }
  isSentMessage(message: ParsedMessage) {
    return (
      message.labelIds?.includes("SENT") ||
      (
        message.headers.from.match(/<([^>]+)>/)?.[1] || message.headers.from
      ).toLowerCase() === this.config.email.toLowerCase()
    );
  }
  isReplyInThread(message: ParsedMessage) {
    return !!(message.headers["in-reply-to"] || message.headers.references);
  }
  async watchEmails() {
    return null;
  }
  async unwatchEmails() {}
  async getMailboxSyncPage(): Promise<MailboxSyncPage> {
    throw new UnsupportedImapOperationError("incremental mailbox sync");
  }
  async syncLocalMail(): Promise<LocalMailSyncResponse> {
    // Initial IMAP support serves the online provider API; no durable offline cursor exists yet.
    return { status: "unsupported", strategy: "folder-delta" };
  }
}

function chronological(a: ParsedMessage, b: ParsedMessage) {
  return new Date(a.date).getTime() - new Date(b.date).getTime();
}
function groupThreads(messages: ParsedMessage[]): EmailThread[] {
  const groups = new Map<string, ParsedMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.threadId) || [];
    group.push(message);
    groups.set(message.threadId, group);
  }
  return [...groups].map(([id, group]) => {
    group.sort(chronological);
    return { id, messages: group, snippet: group.at(-1)?.snippet || "" };
  });
}
function sameRfcId(a: string | undefined, b: string | undefined) {
  return !!a && !!b && parseMessageIdList(a)[0] === parseMessageIdList(b)[0];
}
function replyReferences(references?: string, messageId?: string) {
  return [references, messageId].filter(Boolean).join(" ") || undefined;
}
function addressText(address: ParsedMail["to"]) {
  return Array.isArray(address)
    ? address.map((item) => item.text).join(", ")
    : address?.text || "";
}
function parsedAttachments(mail: ParsedMail): Mail.Attachment[] {
  return mail.attachments.map((attachment) => ({
    filename: attachment.filename,
    content: attachment.content,
    contentType: attachment.contentType,
    contentDisposition:
      attachment.contentDisposition === "inline" ? "inline" : "attachment",
    cid: attachment.cid,
  }));
}
function mailOptions(mail: ParsedMail) {
  return {
    from: mail.from?.text,
    to: addressText(mail.to),
    cc: addressText(mail.cc),
    bcc: addressText(mail.bcc),
    subject: mail.subject || "",
    text: mail.text,
    html: mail.html || undefined,
    replyTo: mail.replyTo?.text,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    references: Array.isArray(mail.references)
      ? mail.references.join(" ")
      : mail.references,
    attachments: parsedAttachments(mail),
  };
}
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}
