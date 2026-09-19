import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { auth } from "@/utils/auth";
import { withImapConnection } from "@/utils/imap/client";
import { testSmtpConnection } from "@/utils/imap/mail";
import { encryptToken } from "@/utils/encryption";
import { linkImapAccountAction } from "./imap";
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));
vi.mock("@/utils/imap/client", () => ({ withImapConnection: vi.fn() }));
vi.mock("@/utils/imap/mail", () => ({ testSmtpConnection: vi.fn() }));
vi.mock("@/utils/encryption", () => ({
  encryptToken: vi.fn(() => "encrypted-credential"),
}));
vi.mock("@/utils/imap/access", () => ({ assertImapAccess: vi.fn() }));
const input = {
  email: "agent@example.com",
  username: "agent@example.com",
  password: "test-bridge-password",
  imapHost: "127.0.0.1",
  imapPort: 1143,
  imapSecurity: "starttls" as const,
  smtpHost: "127.0.0.1",
  smtpPort: 1025,
  smtpSecurity: "starttls" as const,
};
describe("link IMAP account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({
      user: { id: "owner", email: "owner@example.com" },
    } as Awaited<ReturnType<typeof auth>>);
    prisma.emailAccount.findUnique.mockResolvedValue(null);
    prisma.account.create.mockResolvedValue({
      emailAccount: { id: "linked" },
    } as never);
    vi.mocked(withImapConnection).mockResolvedValue(undefined);
    vi.mocked(testSmtpConnection).mockResolvedValue(true);
    vi.mocked(encryptToken).mockReturnValue("encrypted-credential");
  });
  it("requires authentication before accessing a mailbox", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const result = await linkImapAccountAction(input);
    expect(result?.serverError).toBe("Unauthorized");
    expect(withImapConnection).not.toHaveBeenCalled();
    expect(prisma.account.create).not.toHaveBeenCalled();
  });
  it("rejects unverified alias identities", async () => {
    const result = await linkImapAccountAction({
      ...input,
      email: "other@example.com",
    });
    expect(result?.serverError).toContain("Aliases");
    expect(prisma.account.create).not.toHaveBeenCalled();
  });
  it("does not save or reveal credentials after a connection failure", async () => {
    vi.mocked(testSmtpConnection).mockRejectedValueOnce(
      new Error(input.password),
    );
    const result = await linkImapAccountAction(input);
    expect(result?.serverError).toContain("Could not connect securely");
    expect(JSON.stringify(result)).not.toContain(input.password);
    expect(prisma.account.create).not.toHaveBeenCalled();
  });
  it("stores an encrypted credential for the authenticated owner only after both checks", async () => {
    const result = await linkImapAccountAction(input);
    expect(result?.data).toEqual({ emailAccountId: "linked" });
    expect(withImapConnection).toHaveBeenCalledOnce();
    expect(testSmtpConnection).toHaveBeenCalledOnce();
    const created = prisma.account.create.mock.calls[0][0].data;
    expect(created.userId).toBe("owner");
    expect(created.imapCredential?.create?.password).toBe(
      "encrypted-credential",
    );
    expect(JSON.stringify(created)).not.toContain(input.password);
  });
});
