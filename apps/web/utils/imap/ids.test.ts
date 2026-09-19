import { describe, expect, it, vi } from "vitest";
import type { ImapFlow } from "imapflow";
import { decodeMessageId, encodeMessageId, openMessageMailbox } from "./ids";

describe("IMAP identities", () => {
  it("separates reused UIDs across folders and mailbox generations", () => {
    const inbox = encodeMessageId({ path: "INBOX", uidValidity: BigInt(1) }, 7);
    const draft = encodeMessageId(
      { path: "Drafts/ä", uidValidity: BigInt(1) },
      7,
    );
    const reset = encodeMessageId({ path: "INBOX", uidValidity: BigInt(2) }, 7);
    expect(new Set([inbox, draft, reset]).size).toBe(3);
    expect(decodeMessageId(draft)).toMatchObject({
      folder: "Drafts/ä",
      uidValidity: "1",
      uid: 7,
    });
  });
  it("rejects bare UIDs and a reset mailbox before allowing an operation", async () => {
    expect(() => decodeMessageId("7")).toThrow();
    const client = {
      mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: BigInt(2) }),
    } as unknown as ImapFlow;
    await expect(
      openMessageMailbox(
        client,
        encodeMessageId({ path: "Sent", uidValidity: BigInt(1) }, 7),
        false,
      ),
    ).rejects.toThrow("mailbox changed");
    expect(client.mailboxOpen).toHaveBeenCalledWith("Sent", {
      readOnly: false,
    });
  });
});
