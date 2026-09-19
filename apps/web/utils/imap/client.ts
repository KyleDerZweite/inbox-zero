import { ImapFlow } from "imapflow";
import type { ImapCredentialConfig } from "@/utils/imap/types";
import { assertImapAccess } from "@/utils/imap/access";

export function createImapConnection(config: ImapCredentialConfig): ImapFlow {
  assertImapAccess(config.imapHost, config.imapSecurity);
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecurity === "tls",
    doSTARTTLS: config.imapSecurity === "starttls",
    auth: { user: config.username, pass: config.password },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
    tls: { rejectUnauthorized: true },
  });
}

export async function withImapConnection<T>(
  config: ImapCredentialConfig,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createImapConnection(config);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    if (client.usable) await client.logout().catch(() => client.close());
    else client.close();
  }
}
