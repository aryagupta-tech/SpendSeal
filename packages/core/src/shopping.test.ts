import { describe, expect, it } from "vitest";
import { checkoutSnapshotHash, evaluateBrowserCheckout, safeUsdAmountMinor } from "./shopping.js";
import { BrowserOperatorActionSchema, CreateWebPurchaseTaskInputSchema } from "./schemas.js";
import type { BrowserPurchasePermit, CheckoutObservation, ShoppingCandidate, ShoppingTask } from "./schemas.js";

const now = new Date("2026-08-28T10:00:00.000Z");
const task: ShoppingTask = { id: "11111111-1111-4111-8111-111111111111", buyerId: "22222222-2222-4222-8222-222222222222", site: "amazon_in", query: "headphones", productUrl: null, maxTotalPaise: 100_000, requireRefundable: false, minimumReturnWindowDays: null, latestDeliveryDate: null, quantity: 1, currency: "INR", status: "approved", paymentPreference: "online", allowedOrigin: null, purchaseKind: "physical_good", proposedCandidateId: null, selectionConfirmedAt: now.toISOString(), selectedCandidateId: "33333333-3333-4333-8333-333333333333", purchasePermitId: "44444444-4444-4444-8444-444444444444", checkoutSnapshotHash: null, confirmedAt: now.toISOString(), denialReason: null, mode: "prepare_only", expiresAt: "2026-08-28T10:10:00.000Z", createdAt: now.toISOString(), updatedAt: now.toISOString() };
const candidate: ShoppingCandidate = { id: task.selectedCandidateId!, taskId: task.id, canonicalProductId: "B012345678", listingId: "B012345678", title: "Headphones", seller: "Example seller", variant: "Black", condition: "new", availability: "in_stock", pricePaise: 90_000, currency: "INR", productUrl: "https://www.amazon.in/dp/B012345678", snapshotHash: "candidate", observedAt: now.toISOString(), adapterId: "amazon_in", adapterVersion: "1.0.0", selected: true, imageUrl: null, rating: 4.5, reviewCount: 1000, deliveryEstimate: null, rankingReasons: [], proposalSource: "recommended", queryMismatch: false };
const observation: CheckoutObservation = { site: "amazon_in", sourceUrl: candidate.productUrl, canonicalProductId: candidate.canonicalProductId, listingId: candidate.listingId, title: candidate.title, seller: candidate.seller, variant: candidate.variant, condition: "new", quantity: 1, currency: "INR", itemSubtotalPaise: 90_000, shippingPaise: 0, taxPaise: 0, discountPaise: 0, finalTotalPaise: 90_000, extraCartItemCount: 0, refundable: true, returnWindowDays: 7, deliveryDate: "2026-08-30", maskedAddressLabel: "PIN •••001", addressFingerprint: "address-hash", paymentPreference: "online", paymentMethodType: "card", observedAt: now.toISOString(), adapterId: "amazon_in", adapterVersion: "1.0.0", evidenceAssurance: "browser_observed", accountFingerprint: null, maskedAccountLabel: null, recurring: false, finalActionLabel: "Place your order", providerCurrency: null, providerAmountMinor: null, fxQuote: null };

describe("browser checkout policy", () => {
  it("allows an exact supported checkout within the final-total cap", () => expect(evaluateBrowserCheckout({ task, candidate, observation, now }).reasons).toEqual(["ALLOWED"]));
  it("blocks changed domain, seller, variant, extra items and budget overflow", () => {
    const changed = { ...observation, sourceUrl: "https://amazon.example/checkout", seller: "Other", variant: "Blue", condition: "used", extraCartItemCount: 1, finalTotalPaise: 110_000 };
    const result = evaluateBrowserCheckout({ task, candidate, observation: changed, now });
    expect(result.reasons).toEqual(expect.arrayContaining(["DOMAIN_MISMATCH", "SELLER_CHANGED", "VARIANT_CHANGED", "PRODUCT_CHANGED", "UNEXPECTED_CART_ITEMS", "BUDGET_EXCEEDED"]));
  });
  it("rejects stale checkout evidence", () => {
    const stale = { ...observation, observedAt: "2026-08-28T09:49:00.000Z" };
    expect(evaluateBrowserCheckout({ task, candidate, observation: stale, now }).reasons).toContain("CHECKOUT_UNVERIFIABLE");
  });
  it("refuses checkout when the exact seller is unavailable", () => {
    const unknownSeller = { ...observation, seller: null };
    expect(evaluateBrowserCheckout({ task, candidate, observation: unknownSeller, now }).reasons).toContain("CHECKOUT_UNVERIFIABLE");
  });
  it("binds an approved permit to one exact snapshot and rejects replay", () => {
    const permit: BrowserPurchasePermit = { id: task.purchasePermitId!, taskId: task.id, buyerId: task.buyerId, checkoutSnapshot: observation, checkoutSnapshotHash: checkoutSnapshotHash(observation), maxTotalPaise: task.maxTotalPaise, status: "prepared", confirmedAt: now.toISOString(), expiresAt: task.expiresAt, idempotencyKey: "browser-permit", createdAt: now.toISOString() };
    expect(evaluateBrowserCheckout({ task, candidate, observation, permit, now }).reasons).toContain("REPLAY_DETECTED");
    expect(evaluateBrowserCheckout({ task, candidate, observation: { ...observation, finalTotalPaise: 90_100 }, permit: { ...permit, status: "confirmed" }, now }).reasons).toContain("TOTAL_CHANGED");
  });
  it("blocks protected address, delivery and payment changes after approval", () => {
    const permit: BrowserPurchasePermit = { id: task.purchasePermitId!, taskId: task.id, buyerId: task.buyerId, checkoutSnapshot: observation, checkoutSnapshotHash: checkoutSnapshotHash(observation), maxTotalPaise: task.maxTotalPaise, status: "confirmed", confirmedAt: now.toISOString(), expiresAt: task.expiresAt, idempotencyKey: "protected-permit", createdAt: now.toISOString() };
    const changed = { ...observation, addressFingerprint: "other-address", deliveryDate: "2026-08-31", paymentMethodType: "upi" };
    expect(evaluateBrowserCheckout({ task, candidate, observation: changed, permit, now }).reasons).toEqual(expect.arrayContaining(["ADDRESS_CHANGED", "DELIVERY_CHANGED", "PAYMENT_METHOD_CHANGED"]));
  });
  it("maps one permitted HTTPS site and rejects sensitive operator actions", () => {
    expect(CreateWebPurchaseTaskInputSchema.parse({ siteUrl: "https://platform.openai.com/settings/organization/billing", objective: "Buy API credits", maxTotalPaise: 1_000_000 })).toMatchObject({ site: "openai_api", purchaseKind: "api_credits" });
    expect(CreateWebPurchaseTaskInputSchema.parse({ siteUrl: "https://www.amazon.in/s", objective: "Buy a mouse", maxTotalPaise: 50_000 })).toMatchObject({ site: "amazon_in", purchaseKind: "physical_good" });
    expect(CreateWebPurchaseTaskInputSchema.parse({ siteUrl: "https://example.com/buy", objective: "Buy a license", maxTotalPaise: 50_000 })).toMatchObject({ site: "generic_web", purchaseKind: "generic_one_time" });
    expect(() => BrowserOperatorActionSchema.parse({ type: "type", ref: "field", value: "secret", sensitive: true })).toThrow();
  });
  it("keeps a buffered USD purchase under the INR ceiling", () => {
    const cents = safeUsdAmountMinor(1_000_000, 83.5, 10);
    expect(cents).toBe(10_887);
    expect(cents / 100 * 83.5 * 1.1 * 100).toBeLessThanOrEqual(1_000_000);
  });
  it("blocks recurring digital billing and changed destination accounts", () => {
    const digitalTask = { ...task, site: "openai_api" as const, purchaseKind: "api_credits" as const, allowedOrigin: "https://platform.openai.com" };
    const digitalCandidate = { ...candidate, canonicalProductId: "openai-api-prepaid-credits", listingId: "openai-api-prepaid-credits", seller: "OpenAI", productUrl: "https://platform.openai.com/settings/organization/billing", adapterId: "openai_api" as const };
    const fxQuote = { base: "USD" as const, quote: "INR" as const, rate: 83.5, bufferPercent: 10 as const, source: "test", quotedAt: now.toISOString() };
    const digitalObservation = { ...observation, site: "openai_api" as const, sourceUrl: digitalCandidate.productUrl, canonicalProductId: digitalCandidate.canonicalProductId, listingId: digitalCandidate.listingId, seller: "OpenAI", deliveryDate: null, maskedAddressLabel: null, addressFingerprint: null, finalTotalPaise: 91_850, itemSubtotalPaise: 91_850, adapterId: "openai_api" as const, accountFingerprint: "org-one", maskedAccountLabel: "org•••", providerCurrency: "USD", providerAmountMinor: 1_000, fxQuote, finalActionLabel: "Buy credits" };
    expect(evaluateBrowserCheckout({ task: digitalTask, candidate: digitalCandidate, observation: digitalObservation, now }).reasons).toEqual(["ALLOWED"]);
    const permit: BrowserPurchasePermit = { id: task.purchasePermitId!, taskId: task.id, buyerId: task.buyerId, checkoutSnapshot: digitalObservation, checkoutSnapshotHash: checkoutSnapshotHash(digitalObservation), maxTotalPaise: task.maxTotalPaise, status: "confirmed", confirmedAt: now.toISOString(), expiresAt: task.expiresAt, idempotencyKey: "digital", createdAt: now.toISOString() };
    const changed = { ...digitalObservation, recurring: true, accountFingerprint: "org-two" };
    expect(evaluateBrowserCheckout({ task: digitalTask, candidate: digitalCandidate, observation: changed, permit, now }).reasons).toEqual(expect.arrayContaining(["RECURRING_BILLING_DETECTED", "ACCOUNT_CHANGED"]));
  });
});
