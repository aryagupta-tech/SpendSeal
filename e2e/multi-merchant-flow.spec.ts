import { expect, test } from "@playwright/test";

test("merchant publishes a product and buyer completes a passkey-bound test purchase", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page); await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  const suffix = `${Date.now()}-${test.info().workerIndex}`;
  await page.goto("/"); await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Username").fill(`e2e-${suffix}`); await page.getByLabel("Display name").fill("E2E Buyer and Merchant"); await page.getByRole("button", { name: /create account with passkey/i }).click();
  await expect(page.getByRole("heading", { name: /authorization firewall for any merchant/i })).toBeVisible();

  await page.getByLabel("Merchant name").fill("E2E Merchant"); await page.getByLabel("URL slug").fill(`e2e-${suffix}`); await page.getByRole("button", { name: /create merchant/i }).click();
  await expect(page.getByText("E2E Merchant", { exact: true }).first()).toBeVisible();
  await page.getByLabel("SKU", { exact: true }).fill("PLAN-E2E"); await page.getByLabel("Name", { exact: true }).fill("Secure Annual Plan"); await page.getByLabel("Price (₹)", { exact: true }).fill("999"); await page.getByRole("button", { name: /publish product revision/i }).click();
  await expect(page.getByText("Secure Annual Plan", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /use deterministic mock adapter/i }).click();

  await page.getByRole("button", { name: /create buyer-bound mandate/i }).click(); const approval = page.getByRole("link", { name: /review and approve/i }); await expect(approval).toBeVisible(); await approval.click();
  await expect(page).not.toHaveURL(/token=/); await page.getByRole("button", { name: /approve with my passkey/i }).click(); await expect(page.getByText("Passkey approved")).toBeVisible();
  await page.getByRole("button", { name: /run policy and prepare checkout/i }).click(); await page.getByRole("link", { name: /open verified checkout/i }).click();
  await page.getByRole("button", { name: /simulate.*payment/i }).click(); await expect(page.getByText("Payment verified")).toBeVisible(); await page.getByRole("link", { name: /inspect evidence/i }).click(); await expect(page.getByText("SHA-256 chain verified")).toBeVisible();
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});
