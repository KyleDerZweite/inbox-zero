export interface ImapCredentialConfig {
  email: string;
  emailAccountId: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: "tls" | "starttls";
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "tls" | "starttls";
  username: string;
}

export class UnsupportedImapOperationError extends Error {
  constructor(operation: string) {
    super(`Operation "${operation}" is not supported for IMAP accounts`);
    this.name = "UnsupportedImapOperationError";
  }
}
