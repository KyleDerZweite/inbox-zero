CREATE TABLE "ImapCredential" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "imapSecurity" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "smtpSecurity" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    CONSTRAINT "ImapCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ImapCredential_accountId_key" ON "ImapCredential"("accountId");
ALTER TABLE "ImapCredential" ADD CONSTRAINT "ImapCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
