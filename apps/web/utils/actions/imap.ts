"use server";

import { actionClientUser } from "@/utils/actions/safe-action";
import { imapCredentialSchema } from "@/utils/actions/imap.validation";
import { withImapConnection } from "@/utils/imap/client";
import { testSmtpConnection } from "@/utils/imap/mail";
import { assertImapAccess } from "@/utils/imap/access";
import { encryptToken } from "@/utils/encryption";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";

export const linkImapAccountAction = actionClientUser
  .metadata({ name: "linkImapAccount" })
  .inputSchema(imapCredentialSchema)
  .action(async ({ parsedInput: data, ctx: { userId } }) => {
    assertImapAccess(data.imapHost, data.imapSecurity);
    assertImapAccess(data.smtpHost, data.smtpSecurity);
    const email = data.email.trim().toLowerCase();
    // The prototype links the authenticated mailbox, not an unverified alias.
    if (email !== data.username.trim().toLowerCase()) {
      throw new SafeError(
        "Use the email address shown as the Bridge username. Aliases are not supported yet.",
      );
    }
    const existing = await prisma.emailAccount.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) throw new SafeError("This email address is already linked.");
    const config = { ...data, email, emailAccountId: "" };
    try {
      await withImapConnection(config, async (client) => {
        await client.mailboxOpen("INBOX", { readOnly: true });
      });
      await testSmtpConnection(config);
    } catch {
      // Protocol errors can contain credentials or server responses.
      throw new SafeError(
        "Could not connect securely. Check that Bridge is running, its certificate is trusted, and its connection details are correct.",
      );
    }
    const password = encryptToken(data.password);
    if (!password) throw new SafeError("Credential encryption is unavailable.");
    const result = await prisma.account.create({
      data: {
        userId,
        provider: "imap",
        providerAccountId: email,
        type: "credential",
        imapCredential: {
          create: {
            imapHost: data.imapHost,
            imapPort: data.imapPort,
            imapSecurity: data.imapSecurity,
            smtpHost: data.smtpHost,
            smtpPort: data.smtpPort,
            smtpSecurity: data.smtpSecurity,
            username: data.username,
            password,
          },
        },
        emailAccount: {
          create: { email, name: data.name || email.split("@")[0], userId },
        },
      },
      select: { emailAccount: { select: { id: true } } },
    });
    return { emailAccountId: result.emailAccount?.id };
  });
