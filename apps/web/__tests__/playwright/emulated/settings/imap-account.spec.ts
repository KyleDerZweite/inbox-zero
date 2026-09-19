import { expect } from "@playwright/test";
import { test } from "../playwright-test";

test("offers a secure Bridge connection and clears the password when closed", async ({
  page,
}, testInfo) => {
  await page.goto("/accounts");
  await page.getByRole("button", { name: "Add Proton / IMAP account" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Connect Proton Mail Bridge",
  });
  await expect(
    dialog.getByLabel("Bridge password", { exact: true }),
  ).toHaveAttribute("type", "password");
  await expect(dialog.getByLabel("Host", { exact: true }).first()).toHaveValue(
    "127.0.0.1",
  );
  await expect(dialog.getByLabel("Encryption").first()).toHaveValue("starttls");
  await page.screenshot({
    path: testInfo.outputPath("bridge-account-form.png"),
    fullPage: true,
  });
  await dialog
    .getByLabel("Bridge password", { exact: true })
    .fill("synthetic-password");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add Proton / IMAP account" }).click();
  await expect(
    dialog.getByLabel("Bridge password", { exact: true }),
  ).toHaveValue("");
});
