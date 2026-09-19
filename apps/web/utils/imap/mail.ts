import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import type { ImapCredentialConfig } from "@/utils/imap/types";
import { assertImapAccess } from "@/utils/imap/access";
import { ensureEmailSendingEnabled } from "@/utils/mail";

function createSmtpTransport(config: ImapCredentialConfig) {
  assertImapAccess(config.smtpHost, config.smtpSecurity);
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecurity === "tls",
    requireTLS: config.smtpSecurity === "starttls",
    auth: { user: config.username, pass: config.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
    tls: { rejectUnauthorized: true },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

export async function sendSmtpEmail(
  config: ImapCredentialConfig,
  options: Pick<
    Mail.Options,
    | "to"
    | "from"
    | "cc"
    | "bcc"
    | "subject"
    | "text"
    | "html"
    | "replyTo"
    | "inReplyTo"
    | "references"
    | "attachments"
    | "messageId"
  >,
): Promise<{ messageId: string }> {
  ensureEmailSendingEnabled();
  const transport = createSmtpTransport(config);
  try {
    const result = await transport.sendMail({
      ...options,
      from: options.from || config.email,
    });
    return { messageId: result.messageId };
  } finally {
    transport.close();
  }
}

export async function testSmtpConnection(
  config: ImapCredentialConfig,
): Promise<boolean> {
  const transport = createSmtpTransport(config);
  try {
    await transport.verify();
    return true;
  } finally {
    transport.close();
  }
}
