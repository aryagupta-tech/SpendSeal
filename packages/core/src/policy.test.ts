import { describe, expect, it } from "vitest";
import { evaluatePurchasePermit } from "./policy.js";
import { hashAuditPayload } from "./hashing.js";
import type { PurchasePermit, Product } from "./schemas.js";

const merchantId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const buyerId = "44444444-4444-4444-8444-444444444444";
const createdAt = new Date().toISOString();

const product: Product = {
  id: productId,
  merchantId,
  sku: "PRO-ANNUAL",
  name: "Pro Annual",
  description: "",
  pricePaise: 99_900,
  currency: "INR",
  refundable: true,
  refundWindowDays: 7,
  active: true,
  version: 1,
  revisionId,
  snapshotHash: "authorized-snapshot",
  catalogAuthority: { type: "merchant_managed_catalog", merchantId, source: "spendseal_server" },
  refundTermsAuthority: "merchant_stated",
  createdAt,
  updatedAt: createdAt,
};
const intent: PurchasePermit = {
  id: "55555555-5555-4555-8555-555555555555",
  buyerId,
  merchantId,
  productId,
  productRevisionId: revisionId,
  quantity: 1,
  currency: "INR",
  productSnapshotHash: product.snapshotHash,
  lockedUnitPricePaise: 99_900,
  maxTotalPaise: 110_000,
  priceChangePolicy: "none",
  requireRefundable: true,
  minimumRefundWindowDays: 7,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  confirmationRequired: true,
  confirmedAt: new Date().toISOString(),
  idempotencyKey: "key",
  status: "confirmed",
  createdAt,
};

describe("deterministic PurchasePermit policy", () => {
  it("allows an exact, confirmed and unexpired purchase", () => expect(evaluatePurchasePermit(intent, product).reasons).toEqual(["ALLOWED"]));
  it("blocks upward price manipulation and budget overflow", () => {
    const decision = evaluatePurchasePermit(intent, { ...product, pricePaise: 129_900 });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(["PRICE_CHANGED", "BUDGET_EXCEEDED"]));
  });
  it("blocks missing confirmation, expiry, changed refund terms and replay", () => {
    expect(evaluatePurchasePermit({ ...intent, confirmedAt: null }, product).reasons).toContain("CONFIRMATION_REQUIRED");
    expect(evaluatePurchasePermit({ ...intent, expiresAt: new Date(0).toISOString() }, product).reasons).toContain("EXPIRED");
    expect(evaluatePurchasePermit(intent, { ...product, refundable: false, refundWindowDays: 0 }).reasons).toEqual(expect.arrayContaining(["NOT_REFUNDABLE", "REFUND_POLICY_CHANGED"]));
    expect(evaluatePurchasePermit({ ...intent, status: "paid" }, product).reasons).toContain("REPLAY_DETECTED");
  });
  it("makes audit hashes sensitive to any payload change", () => {
    const original = hashAuditPayload("GENESIS", { action: "allow", amount: 99900 });
    const tampered = hashAuditPayload("GENESIS", { action: "allow", amount: 129900 });
    expect(tampered).not.toBe(original);
  });
});
