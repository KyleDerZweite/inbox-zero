import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertImapAccess } from "./access";
const envMock = vi.hoisted(() => ({
  NEXT_PUBLIC_ENABLE_IMAP: true,
  IMAP_ALLOWED_HOSTS: "127.0.0.1,localhost",
}));
vi.mock("@/env", () => ({ env: envMock }));
describe("IMAP connection policy", () => {
  beforeEach(() => {
    envMock.NEXT_PUBLIC_ENABLE_IMAP = true;
  });
  it("allows encrypted loopback connections", () => {
    expect(() => assertImapAccess("localhost", "starttls")).not.toThrow();
  });
  it("rejects non-allowlisted destinations and plaintext", () => {
    expect(() => assertImapAccess("169.254.169.254", "tls")).toThrow(
      "IMAP_ALLOWED_HOSTS",
    );
    expect(() => assertImapAccess("localhost.attacker.example", "tls")).toThrow(
      "IMAP_ALLOWED_HOSTS",
    );
    expect(() => assertImapAccess("localhost", "none")).toThrow("TLS");
  });
  it("cannot be bypassed when the feature is disabled", () => {
    envMock.NEXT_PUBLIC_ENABLE_IMAP = false;
    expect(() => assertImapAccess("localhost", "tls")).toThrow("disabled");
  });
});
