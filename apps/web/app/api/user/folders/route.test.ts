import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
import { GET } from "./route";
const { provider } = vi.hoisted(() => ({
  provider: { name: "imap", getFolders: vi.fn() },
}));
vi.mock("@/utils/middleware", () => ({
  withEmailProvider:
    (_name: string, handler: (request: unknown) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(Object.assign(request, { emailProvider: provider })),
}));
it("allows the IMAP adapter to supply navigable folders", async () => {
  provider.getFolders.mockResolvedValue([
    {
      id: "INBOX",
      displayName: "Inbox",
      childFolders: [],
      systemType: "INBOX",
    },
  ]);
  const response = await GET(
    new NextRequest("http://localhost/api/user/folders"),
    { params: Promise.resolve({}) },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    {
      id: "INBOX",
      displayName: "Inbox",
      childFolders: [],
      systemType: "INBOX",
    },
  ]);
});
