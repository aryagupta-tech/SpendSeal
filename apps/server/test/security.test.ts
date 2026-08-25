import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { CredentialVault } from "../src/credentials.js";
import { MockPaymentAdapter, verifyWebhookSignature } from "../src/payments.js";

describe("credential and payment cryptography", () => {
  it("encrypts credentials with versioned AES-256-GCM and rejects tampering", () => {
    const vault = new CredentialVault(Buffer.alloc(32, 9), 4); const ciphertext = vault.encrypt("rzp_test_secret");
    expect(ciphertext).not.toContain("rzp_test_secret"); expect(ciphertext.startsWith("v4.")).toBe(true); expect(vault.decrypt(ciphertext)).toBe("rzp_test_secret");
    expect(() => vault.decrypt(`${ciphertext.slice(0, -2)}aa`)).toThrow();
  });
  it("uses timing-safe signatures for payment callbacks and raw webhook bodies", () => {
    const adapter = new MockPaymentAdapter("secret"); const signature = adapter.sign("order_1", "pay_1");
    expect(adapter.verifyPayment("order_1", "pay_1", signature)).toBe(true); expect(adapter.verifyPayment("order_1", "pay_2", signature)).toBe(false);
    const raw = Buffer.from('{"event":"payment.captured"}'); const webhook = createHmac("sha256", "webhook").update(raw).digest("hex");
    expect(verifyWebhookSignature(raw, webhook, "webhook")).toBe(true); expect(verifyWebhookSignature(Buffer.from("{}"), webhook, "webhook")).toBe(false);
  });
});
