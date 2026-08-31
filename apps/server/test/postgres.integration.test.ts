import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { CreateWebPurchaseTaskInputSchema, evaluatePurchasePermit, MCP_SCOPES } from "@spendseal/core";
import { createDatabase, runMigrations } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import { OAuthService } from "../src/oauth.js";
import { BrowserAgentService } from "../src/browser-agent.js";
import { SpendSealService } from "../src/service.js";
import { SpendSealStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://agentrail:agentrail-local-only@127.0.0.1:5432/agentrail_test";
let pool: Pool; let store: SpendSealStore; let service: SpendSealService; let browserAgent: BrowserAgentService;

beforeAll(async () => {
  const target = new URL(databaseUrl); const databaseName = target.pathname.slice(1); const admin = new Pool({ connectionString: new URL("/postgres", target).toString() });
  try { await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`); } catch (error) { if ((error as { code?: string }).code !== "42P04") throw error; } finally { await admin.end(); }
  pool = createDatabase(databaseUrl).pool; await runMigrations(pool); store = new SpendSealStore(pool);
  const config = loadConfig({ databaseUrl, publicBaseUrl: "http://agentrail.test", oauthIssuer: "http://agentrail.test", webauthnOrigin: "http://agentrail.test", webauthnRpId: "agentrail.test", credentialEncryptionKey: Buffer.alloc(32, 7) });
  service = new SpendSealService(store, config);
  browserAgent = new BrowserAgentService(pool, false);
}, 30_000);

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE merchant_ai_commerce_events,rate_limits,oauth_tokens,oauth_authorization_codes,audit_events,audit_chain_heads,webhook_events,payment_orders,approval_sessions,webauthn_challenges,intent_locks,merchant_payment_configurations,product_revisions,products,merchant_api_keys,merchant_invitations,merchant_memberships,passkey_credentials,browser_sessions,merchants,users CASCADE`);
});
afterAll(async () => { await pool?.end(); });
afterEach(() => vi.unstubAllGlobals());

async function user(username: string) { return store.createUserWithPasskey({ username, displayName: username, rpId: "agentrail.test", credentialId: `cred_${username}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0, deviceType: "singleDevice", backedUp: false, transports: ["internal"] }); }
async function merchantProduct(ownerName = "owner") { const owner = await user(ownerName); const merchant = await store.createMerchant(owner.id, { slug: `shop-${ownerName}`, displayName: `${ownerName} Shop` }); await service.configurePayments(merchant.id, { adapter: "mock" }); const product = await store.createProduct(owner.id, merchant.id, { sku: "PLAN-1", name: "Annual Plan", description: "A real merchant product", pricePaise: 99_900, refundable: true, refundWindowDays: 7 }); return { owner, merchant, product }; }
async function approvedIntent(buyerName = "buyer") { const buyer = await user(buyerName); const setup = await merchantProduct(`owner-${buyerName}`); const created = await service.createIntent(buyer.id, { merchantId: setup.merchant.id, productId: setup.product.id, maxTotalPaise: 110_000, priceChangePolicy: "none", requireRefundable: true, minimumRefundWindowDays: 7, expiresInMinutes: 10 }, "buyer"); const token = new URL(created.approvalUrl).searchParams.get("token")!; const approval = await store.exchangeApprovalToken(created.intent.id, buyer.id, token); expect(approval).not.toBeNull(); const confirmed = await store.completeApproval({ purchasePermitId: created.intent.id, buyerId: buyer.id, sessionToken: approval!.token, credentialId: `cred_${buyerName}`, counter: 1, deviceType: "singleDevice", backedUp: false }); expect(confirmed?.status).toBe("confirmed"); return { buyer, ...setup, intent: confirmed! }; }

async function approvedBrowserTask(username: string) {
  const buyer = await user(username); const installationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await browserAgent.registerInstallation({ userId: buyer.id, clientId: "spendseal-browser-extension", scopes: ["browser:tasks:read"] }, { installationId, name: "Review Test Chromium" });
  const task = await browserAgent.createTask(buyer.id, { site: "amazon_in", query: "wireless mouse", maxTotalPaise: 100_000, requireRefundable: false, minimumReturnWindowDays: null, latestDeliveryDate: null, expiresInMinutes: 10 });
  const [candidate] = await browserAgent.saveCandidates(buyer.id, installationId, task.id, [{ canonicalProductId: "B012345678", listingId: "B012345678", title: "Wireless mouse", seller: "Seller one", variant: "Black", condition: "new", availability: "available", pricePaise: 80_000, currency: "INR", productUrl: "https://www.amazon.in/dp/B012345678", snapshotHash: "mouse-one", observedAt: new Date().toISOString(), adapterId: "amazon_in", adapterVersion: "2.0.0" }]);
  const proposed = await browserAgent.proposeCandidate(task.id, buyer.id, installationId, { candidateId: candidate!.id, source: "recommended" });
  await browserAgent.confirmCandidate(task.id, buyer.id, installationId, proposed.proposal.id); await browserAgent.reportStatus(task.id, buyer.id, installationId, "navigating"); await browserAgent.setPaymentPreference(task.id, buyer.id, installationId, "online");
  const observation = { site: "amazon_in" as const, sourceUrl: "https://www.amazon.in/gp/buy/spc", canonicalProductId: "B012345678", listingId: "B012345678", title: "Wireless mouse", seller: "Seller one", variant: "Black", condition: "new", quantity: 1, currency: "INR" as const, itemSubtotalPaise: 80_000, shippingPaise: 0, taxPaise: 0, discountPaise: 0, finalTotalPaise: 80_000, extraCartItemCount: 0, refundable: true, returnWindowDays: 7, deliveryDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), maskedAddressLabel: "PIN ••••01", addressFingerprint: "address-one", paymentPreference: "online" as const, paymentMethodType: "card", observedAt: new Date().toISOString(), adapterId: "amazon_in" as const, adapterVersion: "2.0.0", evidenceAssurance: "browser_observed" as const, accountFingerprint: null, maskedAccountLabel: null, recurring: false, finalActionLabel: "Place your order", providerCurrency: null, providerAmountMinor: null, fxQuote: null };
  const observed = await browserAgent.observeCheckout(task.id, buyer.id, installationId, observation); expect(observed.allowed).toBe(true); await browserAgent.approve(task.id, buyer.id);
  return { buyer, installationId, task, permitId: observed.permit!.id };
}

describe("PostgreSQL tenant and payment invariants", () => {
  it("negotiates three visible rounds without exposing the encrypted merchant minimum", async () => {
    const owner = await user("deal-owner"); const buyer = await user("deal-buyer"); const merchant = await store.createMerchant(owner.id, { slug: "deal-shop", displayName: "Deal Shop" });
    const product = await store.createProduct(owner.id, merchant.id, { sku: "DEAL-1", name: "Selling Plans Ski Wax", description: "Negotiable product", pricePaise: 4_995, refundable: false, refundWindowDays: 0 });
    await service.deals.savePolicy({ merchantId: merchant.id, productId: product.id, minimumPricePaise: 4_200, actorUserId: owner.id });
    const encrypted = await pool.query("SELECT floor_price_ciphertext FROM merchant_deal_policies WHERE merchant_id=$1", [merchant.id]); expect(encrypted.rows[0].floor_price_ciphertext).not.toContain("4200");
    const started = await service.deals.start({ buyerId: buyer.id, productId: product.id, buyerMaxTotalPaise: 4_500, initialOfferPaise: 4_000, idempotencyKey: "deal-three-rounds" });
    expect(started.rounds[0]).toMatchObject({ response: "counter", merchantCounterPaise: 4_797 });
    const second = await service.deals.counter({ buyerId: buyer.id, dealSessionId: started.id, offerPaise: 4_300 }); expect(second.rounds[1]).toMatchObject({ response: "counter", merchantCounterPaise: 4_518 });
    const accepted = await service.deals.counter({ buyerId: buyer.id, dealSessionId: started.id, offerPaise: 4_450 }); expect(accepted).toMatchObject({ status: "accepted", acceptedPricePaise: 4_450, roundCount: 3 });
    const events = await store.auditTrail("deal", started.id); const serialized = JSON.stringify({ deal: accepted, events }); expect(serialized).not.toContain("minimumPricePaise"); expect(serialized).not.toContain("floor_price");
    expect(JSON.stringify(events)).not.toContain("buyerMaxTotalPaise");
    expect(await store.verifyAudit("deal", started.id)).toMatchObject({ valid: true, brokenAt: null });
  });

  it("makes negotiation starts idempotent and enforces increasing buyer offers", async () => {
    const owner = await user("rules-owner"); const buyer = await user("rules-buyer"); const merchant = await store.createMerchant(owner.id, { slug: "rules-shop", displayName: "Rules Shop" });
    const product = await store.createProduct(owner.id, merchant.id, { sku: "RULES-1", name: "Negotiation Rules", description: "Bounded offers", pricePaise: 4_995, refundable: false, refundWindowDays: 0 });
    await service.deals.savePolicy({ merchantId: merchant.id, productId: product.id, minimumPricePaise: 4_200, actorUserId: owner.id });
    const first = await service.deals.start({ buyerId: buyer.id, productId: product.id, buyerMaxTotalPaise: 4_500, initialOfferPaise: 4_000, idempotencyKey: "same-negotiation-start" });
    const replay = await service.deals.start({ buyerId: buyer.id, productId: product.id, buyerMaxTotalPaise: 4_500, initialOfferPaise: 4_000, idempotencyKey: "same-negotiation-start" });
    expect(replay.id).toBe(first.id); expect(replay.rounds).toHaveLength(1);
    const resumed = await service.deals.start({ buyerId: buyer.id, productId: product.id, buyerMaxTotalPaise: 4_400, initialOfferPaise: 4_100, idempotencyKey: "fresh-chat-resume" });
    expect(resumed.id).toBe(first.id); expect(resumed.rounds).toHaveLength(1); expect(resumed.buyerMaxTotalPaise).toBe(4_500); expect(resumed.rounds[0]?.buyerOfferPaise).toBe(4_000);
    await expect(service.deals.counter({ buyerId: buyer.id, dealSessionId: first.id, offerPaise: 3_999 })).rejects.toMatchObject({ code: "NEGOTIATION_LIMIT_REACHED" });
    await expect(service.deals.counter({ buyerId: buyer.id, dealSessionId: first.id, offerPaise: 4_501 })).rejects.toMatchObject({ code: "OFFER_ABOVE_BUYER_LIMIT" });
  });

  it("seals an accepted deal into one passkey-gated payment at the negotiated amount", async () => {
    const owner = await user("seal-owner"); const buyer = await user("seal-buyer"); const merchant = await store.createMerchant(owner.id, { slug: "seal-shop", displayName: "Seal Shop" }); await service.configurePayments(merchant.id, { adapter: "mock" });
    const product = await store.createProduct(owner.id, merchant.id, { sku: "SEAL-1", name: "Negotiated Wax", description: "Negotiable product", pricePaise: 4_995, refundable: false, refundWindowDays: 0 }); await service.deals.savePolicy({ merchantId: merchant.id, productId: product.id, minimumPricePaise: 4_200, actorUserId: owner.id });
    let deal = await service.deals.start({ buyerId: buyer.id, productId: product.id, buyerMaxTotalPaise: 4_500, initialOfferPaise: 4_000, idempotencyKey: "seal-accepted-deal" }); deal = await service.deals.counter({ buyerId: buyer.id, dealSessionId: deal.id, offerPaise: 4_300 }); deal = await service.deals.counter({ buyerId: buyer.id, dealSessionId: deal.id, offerPaise: 4_450 });
    const created = await service.deals.createPermit({ buyerId: buyer.id, dealSessionId: deal.id }); expect(created.intent.negotiatedDeal).toMatchObject({ publicUnitPricePaise: 4_995, negotiatedUnitPricePaise: 4_450, savingsPaise: 545 });
    const approval = await store.exchangeApprovalToken(created.intent.id, buyer.id, created.approvalToken!); await store.completeApproval({ purchasePermitId: created.intent.id, buyerId: buyer.id, sessionToken: approval!.token, credentialId: "cred_seal-buyer", counter: 1, deviceType: "singleDevice", backedUp: false });
    const checkout = await service.prepareCheckout(buyer.id, created.intent.id); expect(checkout.checkoutUrl).toBeTruthy(); const order = await store.getOrderByIntent(created.intent.id); expect(order?.amountPaise).toBe(4_450);
    const replay = await service.prepareCheckout(buyer.id, created.intent.id); expect(replay.decision.reasons).toContain("REPLAY_DETECTED"); expect((await pool.query("SELECT COUNT(*)::int AS count FROM payment_orders WHERE intent_lock_id=$1", [created.intent.id])).rows[0].count).toBe(1);
  });

  it("counts only a verified Razorpay negotiated payment as constraint-recovered Test Mode GMV", async () => {
    const owner = await user("recovered-owner"); const buyer = await user("recovered-buyer"); const merchant = await store.createMerchant(owner.id, { slug: "recovered-shop", displayName: "Recovered Shop" });
    const product = await store.createProduct(owner.id, merchant.id, { sku: "RECOVERED-1", name: "Recovered Wax", description: "Would fail at public price", pricePaise: 4_995, refundable: false, refundWindowDays: 0 });
    await service.deals.savePolicy({ merchantId: merchant.id, productId: product.id, minimumPricePaise: 4_200, actorUserId: owner.id });
    let deal = await service.deals.start({ buyerId: buyer.id, productId: product.id, buyerMaxTotalPaise: 4_500, initialOfferPaise: 4_000, idempotencyKey: "recovered-deal" });
    deal = await service.deals.counter({ buyerId: buyer.id, dealSessionId: deal.id, offerPaise: 4_300 }); deal = await service.deals.counter({ buyerId: buyer.id, dealSessionId: deal.id, offerPaise: 4_450 });
    const created = await service.deals.createPermit({ buyerId: buyer.id, dealSessionId: deal.id }); const approval = await store.exchangeApprovalToken(created.intent.id, buyer.id, created.approvalToken!);
    await store.completeApproval({ purchasePermitId: created.intent.id, buyerId: buyer.id, sessionToken: approval!.token, credentialId: "cred_recovered-buyer", counter: 1, deviceType: "singleDevice", backedUp: false });
    const razorpayConfig = await store.savePaymentConfig(merchant.id, { adapter: "razorpay", keyId: "rzp_test_recovered", keySecretCiphertext: service.vault.encrypt("test-secret"), webhookSecretCiphertext: service.vault.encrypt("test-webhook"), encryptionKeyVersion: service.vault.version });
    const claim = await service.deals.prepareOrderClaim(created.intent.id, buyer.id, razorpayConfig.version); expect(claim.kind).toBe("claimed"); if (claim.kind !== "claimed") throw new Error("Expected claimed negotiated order");
    const order = await store.completeOrder(claim.order.id, "order_test_recovered", "razorpay"); await store.markPaid(order.id, "pay_test_recovered", "razorpay");
    const summary = await store.merchantAiSalesSummary(merchant.id); expect(summary).toMatchObject({ constraintRecoveredTestOrders: 1, constraintRecoveredTestGmvPaise: 4_450, negotiatedPaymentsVerified: 1 });
    expect(await store.verifyAudit("deal", deal.id)).toMatchObject({ valid: true, brokenAt: null });
  });

  it("returns NO_DEAL without a final counter, permit, or payment order", async () => {
    const owner = await user("nodeal-owner"); const buyer = await user("nodeal-buyer"); const merchant = await store.createMerchant(owner.id, { slug: "nodeal-shop", displayName: "No Deal Shop" });
    const product = await store.createProduct(owner.id, merchant.id, { sku: "NO-DEAL-1", name: "Protected Product", description: "Negotiable product", pricePaise: 4_995, refundable: false, refundWindowDays: 0 }); await service.deals.savePolicy({ merchantId: merchant.id, productId: product.id, minimumPricePaise: 4_200, actorUserId: owner.id });
    let deal = await service.deals.start({ buyerId: buyer.id, productId: product.id, buyerMaxTotalPaise: 4_100, initialOfferPaise: 3_900, idempotencyKey: "no-deal-session" });
    deal = await service.deals.counter({ buyerId: buyer.id, dealSessionId: deal.id, offerPaise: 4_000 }); deal = await service.deals.counter({ buyerId: buyer.id, dealSessionId: deal.id, offerPaise: 4_100 });
    expect(deal.status).toBe("rejected"); expect(deal.rounds.at(-1)).toMatchObject({ response: "rejected", merchantCounterPaise: null, reasonCode: "NO_DEAL" }); expect(deal.purchasePermitId).toBeNull();
    await expect(service.deals.createPermit({ buyerId: buyer.id, dealSessionId: deal.id })).rejects.toMatchObject({ code: "NO_DEAL" }); expect((await pool.query("SELECT COUNT(*)::int AS count FROM payment_orders WHERE merchant_id=$1", [merchant.id])).rows[0].count).toBe(0);
  });

  it("invalidates unfinished deals when the private merchant authority changes", async () => {
    const owner = await user("policy-owner"); const buyer = await user("policy-buyer"); const merchant = await store.createMerchant(owner.id, { slug: "policy-deal-shop", displayName: "Policy Deal Shop" }); const product = await store.createProduct(owner.id, merchant.id, { sku: "POLICY-DEAL", name: "Policy Product", description: "Negotiable product", pricePaise: 5_000, refundable: false, refundWindowDays: 0 });
    await service.deals.savePolicy({ merchantId: merchant.id, productId: product.id, minimumPricePaise: 4_000, actorUserId: owner.id }); const deal = await service.deals.start({ buyerId: buyer.id, productId: product.id, buyerMaxTotalPaise: 4_500, initialOfferPaise: 4_100, idempotencyKey: "policy-change-deal" });
    await service.deals.savePolicy({ merchantId: merchant.id, productId: product.id, minimumPricePaise: 4_200, actorUserId: owner.id }); await expect(service.deals.counter({ buyerId: buyer.id, dealSessionId: deal.id, offerPaise: 4_300 })).rejects.toMatchObject({ code: "DEAL_POLICY_CHANGED" });
    expect((await service.deals.get(buyer.id, deal.id)).status).toBe("invalidated");
  });

  it("keeps products and PurchasePermits isolated across merchants and buyers", async () => {
    const first = await approvedIntent("buyer-a"); const outsider = await user("outsider"); const second = await merchantProduct("owner-b");
    expect(await store.getProduct(second.merchant.id, first.product.id)).toBeNull();
    expect(await store.getIntent(first.intent.id, outsider.id)).toBeNull();
    expect(await store.getIntent(first.intent.id, first.buyer.id)).not.toBeNull();
  });

  it("creates immutable revisions with optimistic concurrency", async () => {
    const { owner, merchant, product } = await merchantProduct();
    const changed = await store.updateProduct(owner.id, merchant.id, product.id, 1, { pricePaise: 129_900 });
    expect(changed).not.toBe("VERSION_CONFLICT"); if (!changed || changed === "VERSION_CONFLICT") throw new Error("Expected updated product"); expect(changed.version).toBe(2); expect(changed.snapshotHash).not.toBe(product.snapshotHash);
    expect(await store.updateProduct(owner.id, merchant.id, product.id, 1, { pricePaise: 149_900 })).toBe("VERSION_CONFLICT");
    expect(await store.productRevisions(merchant.id, product.id)).toHaveLength(2);
  });

  it("synchronizes Shopify variants as immutable authoritative revisions", async () => {
    const owner = await user("shopify-owner"); const merchant = await store.createMerchant(owner.id, { slug: "shopify-store", displayName: "Shopify Store" });
    const connection = await store.saveShopifyConnection({ merchantId: merchant.id, provider: "shopify", shopDomain: "agentrail-test-store.myshopify.com", accessTokenCiphertext: "encrypted-test-token", encryptionKeyVersion: 1, shopName: "SpendSeal Test Store", currency: "INR", defaultRefundable: true, defaultRefundWindowDays: 7 });
    const base = { externalId: "gid://shopify/ProductVariant/42", sku: "SHOPIFY-42", name: "Annual Plan", description: "Real Shopify variant", active: true, externalUpdatedAt: "2026-08-28T05:00:00.000Z" };
    expect((await store.syncShopifyProducts(owner.id, connection, [{ ...base, pricePaise: 99_900 }])).created).toBe(1);
    const first = (await store.listProducts(merchant.id)).products[0]!; expect(first.catalogAuthority).toMatchObject({ source: "shopify_admin_graphql", shopDomain: "agentrail-test-store.myshopify.com" }); expect(first.version).toBe(1);
    expect((await store.syncShopifyProducts(owner.id, connection, [{ ...base, pricePaise: 129_900, externalUpdatedAt: "2026-08-28T06:00:00.000Z" }])).updated).toBe(1);
    const second = await store.getProduct(merchant.id, first.id); expect(second?.version).toBe(2); expect(second?.snapshotHash).not.toBe(first.snapshotHash);
    expect((await store.syncShopifyProducts(owner.id, connection, [])).archived).toBe(1);
    const archived = await store.getProduct(merchant.id, first.id); expect(archived?.active).toBe(false); expect(archived?.version).toBe(3); expect(await store.productRevisions(merchant.id, first.id)).toHaveLength(3);
  });

  it("blocks post-intent price bait-and-switch with observed revision evidence", async () => {
    const setup = await approvedIntent(); await store.updateProduct(setup.owner.id, setup.merchant.id, setup.product.id, 1, { pricePaise: 129_900 });
    const result = await service.prepareCheckout(setup.buyer.id, setup.intent.id);
    expect(result.decision.reasons).toEqual(expect.arrayContaining(["PRICE_CHANGED", "BUDGET_EXCEEDED"]));
    expect(result.decision.observedProductVersion).toBe(2); expect(result.checkoutUrl).toBeUndefined();
  });

  it("automatically re-fetches the exact Shopify variant before policy evaluation", async () => {
    const owner = await user("shopify-policy-owner"); const buyer = await user("shopify-policy-buyer");
    const merchant = await store.createMerchant(owner.id, { slug: "shopify-policy-store", displayName: "Shopify Policy Store" });
    await service.configurePayments(merchant.id, { adapter: "mock" });
    const connection = await store.saveShopifyConnection({ merchantId: merchant.id, provider: "shopify", shopDomain: "agentrail-test-store.myshopify.com", accessTokenCiphertext: service.vault.encrypt("shpat_test_token_123456"), encryptionKeyVersion: service.vault.version, shopName: "Shopify Policy Store", currency: "INR", defaultRefundable: false, defaultRefundWindowDays: 0 });
    const externalId = "gid://shopify/ProductVariant/42";
    await store.syncShopifyProducts(owner.id, connection, [{ externalId, sku: "SHOPIFY-42", name: "Security Plan", description: "Annual access", pricePaise: 2_000, active: true, externalUpdatedAt: "2026-08-28T05:00:00.000Z" }]);
    const product = (await store.listProducts(merchant.id)).products[0]!;
    const created = await service.createIntent(buyer.id, { merchantId: merchant.id, productId: product.id, maxTotalPaise: 2_000, priceChangePolicy: "none", requireRefundable: false, minimumRefundWindowDays: null, expiresInMinutes: 10 }, "buyer");
    const linkToken = new URL(created.approvalUrl).searchParams.get("token")!; const approval = await store.exchangeApprovalToken(created.intent.id, buyer.id, linkToken);
    await store.completeApproval({ purchasePermitId: created.intent.id, buyerId: buyer.id, sessionToken: approval!.token, credentialId: "cred_shopify-policy-buyer", counter: 1, deviceType: "singleDevice", backedUp: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { node: { id: externalId, title: "Default Title", sku: "SHOPIFY-42", price: "30.00", updatedAt: "2026-08-28T06:00:00Z", availableForSale: true, product: { id: "gid://shopify/Product/7", title: "Security Plan", description: "Annual access", status: "ACTIVE", updatedAt: "2026-08-28T06:00:00Z" } } } }), { status: 200, headers: { "content-type": "application/json" } })));
    const result = await service.prepareCheckout(buyer.id, created.intent.id);
    expect(result.decision.reasons).toEqual(expect.arrayContaining(["PRICE_CHANGED", "BUDGET_EXCEEDED"]));
    expect(result.checkoutUrl).toBeUndefined(); expect(result.decision.observedPricePaise).toBe(3_000);
    const events = await store.auditTrail("intent", created.intent.id); expect(events.map((event) => event.eventType)).toContain("AUTHORITATIVE_PRODUCT_REFRESHED");
  });

  it("claims exactly one local payment attempt under concurrency and blocks replay", async () => {
    const setup = await approvedIntent(); const results = await Promise.all([service.prepareCheckout(setup.buyer.id, setup.intent.id), service.prepareCheckout(setup.buyer.id, setup.intent.id), service.prepareCheckout(setup.buyer.id, setup.intent.id)]);
    expect(results.filter((value) => value.checkoutUrl).length).toBeGreaterThanOrEqual(1);
    const count = await pool.query("SELECT count(*)::int AS count FROM payment_orders WHERE intent_lock_id=$1", [setup.intent.id]); expect(count.rows[0].count).toBe(1);
    const replay = await service.prepareCheckout(setup.buyer.id, setup.intent.id); expect(replay.decision.reasons).toContain("REPLAY_DETECTED");
  });

  it("stores scoped API keys only as hashes and enforces revocation", async () => {
    const { merchant } = await merchantProduct(); const created = await store.createApiKey(merchant.id, "catalog", ["catalog:read"], null);
    const persisted = await pool.query("SELECT secret_hash FROM merchant_api_keys WHERE id=$1", [created.id]); expect(persisted.rows[0].secret_hash).not.toContain(created.key);
    expect((await store.authenticateApiKey(created.key))?.merchantId).toBe(merchant.id); await store.revokeApiKey(merchant.id, created.id); expect(await store.authenticateApiKey(created.key)).toBeNull();
  });

  it("does not rotate an unchanged Razorpay Test configuration on repeated import", async () => {
    const owner = await user("payment-owner"); const merchant = await store.createMerchant(owner.id, { slug: "payment-shop", displayName: "Payment Shop" });
    await store.savePaymentConfig(merchant.id, { adapter: "razorpay", keyId: "rzp_test_idempotent", keySecretCiphertext: service.vault.encrypt("same-test-secret"), webhookSecretCiphertext: service.vault.encrypt("webhook-secret"), encryptionKeyVersion: service.vault.version });
    const result = await service.configurePayments(merchant.id, { adapter: "razorpay", keyId: "rzp_test_idempotent", keySecret: "same-test-secret" });
    expect(result.alreadyConnected).toBe(true); expect(result.configuration.version).toBe(1); expect(result.webhookSecret).toBeUndefined();
    const count = await pool.query("SELECT count(*)::int AS count FROM merchant_payment_configurations WHERE merchant_id=$1", [merchant.id]); expect(count.rows[0].count).toBe(1);
  });

  it("rotates an exposed Razorpay webhook secret once without exposing API credentials", async () => {
    const owner = await user("webhook-owner"); const merchant = await store.createMerchant(owner.id, { slug: "webhook-shop", displayName: "Webhook Shop" });
    const original = await store.savePaymentConfig(merchant.id, { adapter: "razorpay", keyId: "rzp_test_webhook", keySecretCiphertext: service.vault.encrypt("test-api-secret"), webhookSecretCiphertext: service.vault.encrypt("exposed-webhook-secret"), encryptionKeyVersion: service.vault.version });
    const rotated = await service.rotateRazorpayWebhookSecret(merchant.id); expect(rotated.webhookSecret).not.toBe("exposed-webhook-secret"); expect(rotated.configuration.version).toBe(original.version + 1);
    const active = await store.paymentConfig(merchant.id); expect(active?.keySecretCiphertext).toBe(original.keySecretCiphertext); expect(service.vault.decrypt(active!.webhookSecretCiphertext!)).toBe(rotated.webhookSecret);
    const events = await store.auditTrail("merchant", merchant.id); expect(events.at(-1)?.eventType).toBe("RAZORPAY_WEBHOOK_SECRET_ROTATED"); expect(JSON.stringify(events.at(-1)?.payload)).not.toContain(rotated.webhookSecret);
  });

  it("labels mock payment audit events as the mock adapter", async () => {
    const setup = await approvedIntent("mock-audit-buyer"); await service.prepareCheckout(setup.buyer.id, setup.intent.id);
    const order = await store.getOrderByIntent(setup.intent.id); expect(order).not.toBeNull(); await service.completeMockPayment(order!.id);
    const events = await store.auditTrail("intent", setup.intent.id); const paymentEvents = events.filter((event) => event.eventType === "PAYMENT_ORDER_CREATED" || event.eventType === "PAYMENT_VERIFIED");
    expect(paymentEvents).toHaveLength(2); expect(paymentEvents.every((event) => event.actor === "mock_adapter")).toBe(true);
  });

  it("promotes a Shopify and Razorpay merchant through clear AI-sales readiness states", async () => {
    const owner = await user("readiness-owner"); const merchant = await store.createMerchant(owner.id, { slug: "readiness-shop", displayName: "Readiness Shop" });
    expect((await store.merchantReadiness(merchant.id)).status).toBe("not_ready");
    const connection = await store.saveShopifyConnection({ merchantId: merchant.id, provider: "shopify", shopDomain: "readiness-shop.myshopify.com", accessTokenCiphertext: "encrypted-token", encryptionKeyVersion: 1, shopName: "Readiness Shop", currency: "INR", defaultRefundable: false, defaultRefundWindowDays: 0 });
    await store.syncShopifyProducts(owner.id, connection, [{ externalId: "gid://shopify/ProductVariant/ready", sku: "READY-1", name: "AI-ready product", description: "Authoritative Shopify product", pricePaise: 2_000, active: true, externalUpdatedAt: new Date().toISOString() }]);
    expect((await store.merchantReadiness(merchant.id)).status).toBe("catalog_ready");
    await store.savePaymentConfig(merchant.id, { adapter: "razorpay", keyId: "rzp_test_readiness", keySecretCiphertext: service.vault.encrypt("test-secret"), webhookSecretCiphertext: service.vault.encrypt("test-webhook"), encryptionKeyVersion: service.vault.version });
    expect(await store.merchantReadiness(merchant.id)).toMatchObject({ status: "ai_transactable", shopifyConnected: true, razorpayTestModeConnected: true, productsAvailable: 1, webhookStatus: "configured_unverified" });
    await store.recordWebhook(merchant.id, "event-ready", "payment.captured");
    expect((await store.merchantReadiness(merchant.id)).webhookStatus).toBe("verified");
  });

  it("returns an active agent-readable storefront and deduplicates repeated discovery reads", async () => {
    const owner = await user("storefront-owner"); const buyer = await user("storefront-buyer"); const merchant = await store.createMerchant(owner.id, { slug: "agent-storefront", displayName: "Agent Storefront" });
    const active = await store.createProduct(owner.id, merchant.id, { sku: "ACTIVE-1", name: "Active product", description: "Shown to AI buyers", pricePaise: 4_900, refundable: true, refundWindowDays: 7 });
    const archived = await store.createProduct(owner.id, merchant.id, { sku: "OLD-1", name: "Archived product", description: "Must stay hidden", pricePaise: 3_900, refundable: false, refundWindowDays: 0 });
    await store.updateProduct(owner.id, merchant.id, archived.id, archived.version, { active: false });
    const first = await store.merchantStorefront(merchant.slug, buyer.id); const second = await store.merchantStorefront(merchant.slug, buyer.id);
    expect(first?.products.map((product) => product.id)).toEqual([active.id]); expect(second?.products).toHaveLength(1); expect(first?.checkout).toMatchObject({ buyerPasskeyRequired: true, livePaymentMode: "test", razorpayTestModeAvailable: false });
    const summary = await store.merchantAiSalesSummary(merchant.id); expect(summary).toMatchObject({ catalogDiscoveries: 1, productsShown: 1 });
  });

  it("counts only verified AI-attributed Razorpay Test payments as Test Mode GMV", async () => {
    const setup = await approvedIntent("analytics-buyer-mock"); const mockCheckout = await service.prepareCheckout(setup.buyer.id, setup.intent.id); expect(mockCheckout.checkoutUrl).toBeTruthy(); const mockOrder = await store.getOrderByIntent(setup.intent.id); await service.completeMockPayment(mockOrder!.id);
    const razorpayConfig = await store.savePaymentConfig(setup.merchant.id, { adapter: "razorpay", keyId: "rzp_test_analytics", keySecretCiphertext: service.vault.encrypt("test-secret"), webhookSecretCiphertext: service.vault.encrypt("test-webhook"), encryptionKeyVersion: service.vault.version });
    const buyer = await user("analytics-buyer-razorpay"); const created = await service.createIntent(buyer.id, { merchantId: setup.merchant.id, productId: setup.product.id, maxTotalPaise: setup.product.pricePaise, priceChangePolicy: "none", requireRefundable: false, minimumRefundWindowDays: null, expiresInMinutes: 10 });
    const token = new URL(created.approvalUrl).searchParams.get("token")!; const approval = await store.exchangeApprovalToken(created.intent.id, buyer.id, token); await store.completeApproval({ purchasePermitId: created.intent.id, buyerId: buyer.id, sessionToken: approval!.token, credentialId: "cred_analytics-buyer-razorpay", counter: 1, deviceType: "singleDevice", backedUp: false });
    const claim = await store.prepareOrderClaim(created.intent.id, buyer.id, evaluatePurchasePermit, razorpayConfig.version); expect(claim.kind).toBe("claimed"); if (claim.kind !== "claimed") throw new Error("Expected claimed Razorpay Test order");
    const order = await store.completeOrder(claim.order.id, "order_test_analytics", "razorpay"); await store.markPaid(order.id, "pay_test_analytics", "razorpay");
    const summary = await store.merchantAiSalesSummary(setup.merchant.id); expect(summary).toMatchObject({ purchasePermitsCreated: 1, passkeyApprovals: 1, razorpayTestOrdersCreated: 1, razorpayTestPaymentsVerified: 1, testGmvPaise: setup.product.pricePaise }); expect(summary.topProducts[0]).toMatchObject({ productId: setup.product.id, selections: 1 });
  });

  it("keeps merchant AI-sales analytics tenant isolated", async () => {
    const first = await merchantProduct("analytics-tenant-one"); const second = await merchantProduct("analytics-tenant-two");
    await store.recordAiCommerceEvent({ merchantId: first.merchant.id, productId: first.product.id, eventType: "CATALOG_DISCOVERED", source: "chatgpt_mcp", deduplicationKey: "first-only" });
    expect((await store.merchantAiSalesSummary(first.merchant.id)).catalogDiscoveries).toBe(1); expect((await store.merchantAiSalesSummary(second.merchant.id)).catalogDiscoveries).toBe(0);
    expect(await store.requireMembership(first.owner.id, second.merchant.id, ["owner", "admin", "catalog_manager", "auditor"])).toBeNull();
  });

  it("prepares one browser purchase, blocks replay, and verifies its task chain", async () => {
    const buyer = await user("browser-buyer");
    const installationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await browserAgent.registerInstallation(
      { userId: buyer.id, clientId: "spendseal-browser-extension", scopes: ["browser:tasks:read"] },
      { installationId, name: "Test Chromium" },
    );
    const task = await browserAgent.createTask(buyer.id, {
      site: "amazon_in",
      query: "headphones",
      maxTotalPaise: 100_000,
      requireRefundable: false,
      minimumReturnWindowDays: null,
      latestDeliveryDate: null,
      expiresInMinutes: 10,
    });
    const candidates = await browserAgent.saveCandidates(buyer.id, installationId, task.id, [{
      canonicalProductId: "B012345678",
      listingId: "B012345678",
      title: "Test headphones",
      seller: "Test seller",
      variant: "Black",
      condition: "new",
      availability: "available",
      pricePaise: 90_000,
      currency: "INR",
      productUrl: "https://www.amazon.in/dp/B012345678",
      snapshotHash: "candidate-snapshot",
      observedAt: new Date().toISOString(),
      adapterId: "amazon_in",
      adapterVersion: "1.0.0",
    }]);
    const review = await browserAgent.proposeCandidate(task.id, buyer.id, installationId, { candidateId: candidates[0]!.id, source: "recommended" });
    expect(review.task.status).toBe("product_review_required");
    expect(review.task.selectedCandidateId).toBeNull();
    expect(review.proposal.source).toBe("recommended");
    const confirmed = await browserAgent.confirmCandidate(task.id, buyer.id, installationId, review.proposal.id);
    expect(confirmed.status).toBe("selection_confirmed");
    expect(confirmed.selectedCandidateId).toBe(candidates[0]!.id);
    await browserAgent.reportStatus(task.id, buyer.id, installationId, "navigating", "Opening protected checkout");
    await browserAgent.setPaymentPreference(task.id, buyer.id, installationId, "online");
    const observation = {
      site: "amazon_in" as const,
      sourceUrl: "https://www.amazon.in/gp/buy/spc",
      canonicalProductId: "B012345678",
      listingId: "B012345678",
      title: "Test headphones",
      seller: "Test seller",
      variant: "Black",
      condition: "new",
      quantity: 1,
      currency: "INR" as const,
      itemSubtotalPaise: 90_000,
      shippingPaise: 0,
      taxPaise: 0,
      discountPaise: 0,
      finalTotalPaise: 90_000,
      extraCartItemCount: 0,
      refundable: null,
      returnWindowDays: null,
      deliveryDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
      maskedAddressLabel: "PIN ••••01",
      addressFingerprint: "address-fingerprint",
      paymentPreference: "online" as const,
      paymentMethodType: "card",
      observedAt: new Date().toISOString(),
      adapterId: "amazon_in" as const,
      adapterVersion: "1.0.0",
      evidenceAssurance: "browser_observed" as const,
      accountFingerprint: null,
      maskedAccountLabel: null,
      recurring: false,
      finalActionLabel: "Place your order",
      providerCurrency: null,
      providerAmountMinor: null,
      fxQuote: null,
    };
    expect((await browserAgent.observeCheckout(task.id, buyer.id, installationId, observation)).allowed).toBe(true);
    await browserAgent.approve(task.id, buyer.id);
    const claims = await Promise.all([
      browserAgent.claimExecution(task.id, buyer.id, installationId, observation),
      browserAgent.claimExecution(task.id, buyer.id, installationId, observation),
    ]);
    expect(claims.map((claim) => claim.status).sort()).toEqual(["denied", "prepared"]);
    expect(claims.find((claim) => claim.status === "denied")?.reason).toBe("REPLAY_DETECTED");
    const attempts = await pool.query("SELECT count(*)::int AS count FROM browser_execution_attempts WHERE task_id=$1", [task.id]);
    expect(attempts.rows[0].count).toBe(1);
    const audit = await browserAgent.audit(task.id, buyer.id);
    expect(audit.verification).toMatchObject({ valid: true, brokenAt: null });
    expect(audit.events.map((event) => event.eventType)).toEqual(expect.arrayContaining(["PURCHASE_PREPARED", "REPLAY_BLOCKED"]));
  });

  it("invalidates an approved Purchase Seal when the buyer opens another product", async () => {
    const setup = await approvedBrowserTask("manual-replacement-buyer");
    const replacement = await browserAgent.proposeCandidate(setup.task.id, setup.buyer.id, setup.installationId, {
      source: "manual",
      candidate: { canonicalProductId: "B087654321", listingId: "B087654321", title: "Ergonomic wireless mouse", seller: "Seller two", variant: "Graphite", condition: "new", availability: "available", pricePaise: 85_000, currency: "INR", productUrl: "https://www.amazon.in/dp/B087654321", snapshotHash: "mouse-two", observedAt: new Date().toISOString(), adapterId: "amazon_in", adapterVersion: "2.0.0", imageUrl: null, rating: 4.6, reviewCount: 2400, deliveryEstimate: "Tomorrow", rankingReasons: ["You opened this product yourself"], proposalSource: "manual", queryMismatch: false },
    });
    expect(replacement.task).toMatchObject({ status: "product_review_required", selectedCandidateId: null, purchasePermitId: null, confirmedAt: null });
    expect(replacement.proposal.source).toBe("manual");
    expect((await pool.query("SELECT status FROM browser_purchase_permits WHERE id=$1", [setup.permitId])).rows[0].status).toBe("denied");
    expect((await pool.query("SELECT count(*)::int AS count FROM shopping_candidates WHERE task_id=$1 AND selected", [setup.task.id])).rows[0].count).toBe(0);
    const audit = await browserAgent.audit(setup.task.id, setup.buyer.id);
    expect(audit.verification.valid).toBe(true);
    expect(audit.events.map((event) => event.eventType)).toContain("PRODUCT_SELECTION_INVALIDATED");
  });

  it("binds visible operator commands and redacted evidence to one granted domain", async () => {
    const buyer = await user("operator-buyer"); const installationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await browserAgent.registerInstallation({ userId: buyer.id, clientId: "spendseal-browser-extension", scopes: ["browser:tasks:read"] }, { installationId, name: "Operator Chromium" });
    const task = await browserAgent.createWebTask(buyer.id, CreateWebPurchaseTaskInputSchema.parse({ siteUrl: "https://example.com/shop", objective: "Buy a one-time software license", maxTotalPaise: 50_000, purchaseKind: "api_credits", requireRefundable: false, minimumReturnWindowDays: null, latestDeliveryDate: null, expiresInMinutes: 15 }));
    expect(task).toMatchObject({ site: "generic_web", purchaseKind: "generic_one_time", mode: "prepare_only" });
    await browserAgent.recordSiteGrant(task.id, buyer.id, installationId, "https://example.com");
    await expect(browserAgent.queueOperatorAction(task.id, buyer.id, { type: "navigate", url: "https://lookalike.example/shop" })).rejects.toThrow("DOMAIN_MISMATCH");
    const queued = await browserAgent.queueOperatorAction(task.id, buyer.id, { type: "navigate", url: "https://example.com/product/one" });
    const command = await browserAgent.claimOperatorCommand(task.id, buyer.id, installationId); expect(command).toMatchObject({ id: queued.commandId, action: { type: "navigate" } });
    const snapshot = { url: "https://example.com/product/one", title: "One-time license", site: "generic_web" as const, capturedAt: new Date().toISOString(), text: ["One-time license", "INR 499"], controls: [{ ref: "ss-0", role: "button", label: "Review license", disabled: false }], prices: [{ label: "Visible price 1", amount: "INR 499" }], sensitiveContentRemoved: true as const, screenshotIncluded: false as const };
    await browserAgent.completeOperatorCommand(task.id, buyer.id, installationId, queued.commandId, { status: "completed", result: { navigated: true }, snapshot });
    expect((await browserAgent.operatorState(task.id, buyer.id)).snapshot).toMatchObject({ url: snapshot.url, screenshotIncluded: false, sensitiveContentRemoved: true });
  });

  it("lets every authenticated buyer opt into live task mode without an owner allowlist", async () => {
    const owner = await user("browser-live-owner"); const other = await user("browser-prepare-only");
    const controlled = new BrowserAgentService(pool, true, true);
    const input = { site: "flipkart_in" as const, query: "wireless mouse", maxTotalPaise: 100_000, requireRefundable: false, minimumReturnWindowDays: null, latestDeliveryDate: null, expiresInMinutes: 10 };
    expect((await controlled.createTask(owner.id, input)).mode).toBe("prepare_only");
    await controlled.setLiveModePreference(owner.id, true);
    await controlled.setLiveModePreference(other.id, true);
    expect((await controlled.createTask(owner.id, input)).mode).toBe("live");
    expect((await controlled.createTask(other.id, input)).mode).toBe("live");
  });

  it("lets the buyer abandon final checkout and safely choose another product", async () => {
    const setup = await approvedBrowserTask("browser-reselect-buyer");
    const restarted = await browserAgent.restartProductSelection(setup.task.id, setup.buyer.id, setup.installationId);
    expect(restarted).toMatchObject({ status: "searching", selectedCandidateId: null, purchasePermitId: null, checkoutSnapshotHash: null, paymentPreference: null });
    const permit = await pool.query("SELECT status FROM browser_purchase_permits WHERE id=$1", [setup.permitId]);
    expect(permit.rows[0].status).toBe("denied");
    const events = await browserAgent.audit(setup.task.id, setup.buyer.id);
    expect(events.events.at(-1)?.eventType).toBe("PRODUCT_RESELECTION_REQUESTED");
    expect(events.verification).toMatchObject({ valid: true, brokenAt: null });
  });

  it("rejects audit mutation and detects offline tampering", async () => {
    const setup = await approvedIntent(); expect((await store.verifyAudit("intent", setup.intent.id)).valid).toBe(true);
    await expect(pool.query("UPDATE audit_events SET payload_json='{}' WHERE scope_type='intent' AND scope_id=$1", [setup.intent.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM audit_events WHERE scope_type='intent' AND scope_id=$1", [setup.intent.id])).rejects.toThrow(/append-only/);
  });
});

describe("OAuth 2.1 buyer binding", () => {
  it("separates extension browser scopes from ChatGPT MCP scopes", () => {
    const config = loadConfig({ databaseUrl, publicBaseUrl: "http://agentrail.test", oauthIssuer: "http://agentrail.test", webauthnOrigin: "http://agentrail.test", webauthnRpId: "agentrail.test", credentialEncryptionKey: Buffer.alloc(32, 5) });
    const oauth = new OAuthService(store, config);
    expect(oauth.protectedResourceMetadata().scopes_supported).toEqual([...MCP_SCOPES]);
    expect(oauth.authorizationServerMetadata().scopes_supported).toEqual([...MCP_SCOPES]);
    expect(oauth.authorizationServerMetadata().scopes_supported).not.toContain("browser:execute");
    const extensionRequest = oauth.validateAuthorizationRequest({ response_type: "code", client_id: config.extensionOauthClientId, redirect_uri: `https://${"a".repeat(32)}.chromiumapp.org/oauth2`, resource: config.publicBaseUrl, code_challenge: "challenge", code_challenge_method: "S256", scope: "browser:tasks:read browser:observations:write" });
    expect(extensionRequest.scopes).toEqual(["browser:tasks:read", "browser:observations:write"]);
    const chatGptRequest = oauth.validateAuthorizationRequest({ response_type: "code", client_id: "https://chatgpt.com/oauth/client.json", redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", resource: config.publicBaseUrl, code_challenge: "challenge", code_challenge_method: "S256", scope: oauth.authorizationServerMetadata().scopes_supported.join(" ") });
    expect(chatGptRequest.scopes).toEqual([...MCP_SCOPES]);
    const staleChatGptRequest = oauth.validateAuthorizationRequest({ response_type: "code", client_id: "https://chatgpt.com/oauth/client.json", redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", resource: config.publicBaseUrl, code_challenge: "challenge", code_challenge_method: "S256", scope: "catalog:read browser:tasks:read browser:execute" });
    expect(staleChatGptRequest.scopes).toEqual(["catalog:read"]);
    expect(() => oauth.validateAuthorizationRequest({ response_type: "code", client_id: "https://chatgpt.com/oauth/client.json", redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", resource: config.publicBaseUrl, code_challenge: "challenge", code_challenge_method: "S256", scope: "browser:tasks:read" })).toThrowError(/scope/i);
    expect(() => oauth.validateAuthorizationRequest({ response_type: "code", client_id: config.extensionOauthClientId, redirect_uri: `https://${"a".repeat(32)}.chromiumapp.org/oauth2`, resource: config.publicBaseUrl, code_challenge: "challenge", code_challenge_method: "S256", scope: "catalog:read" })).toThrowError(/scope/i);
  });

  it("enforces S256 PKCE, single-use codes, rotating refresh tokens, and reuse-family revocation", async () => {
    const buyer = await user("oauth-buyer"); const config = loadConfig({ databaseUrl, publicBaseUrl: "http://agentrail.test", oauthIssuer: "http://agentrail.test", webauthnOrigin: "http://agentrail.test", webauthnRpId: "agentrail.test", credentialEncryptionKey: Buffer.alloc(32, 3) }); const oauth = new OAuthService(store, config);
    const verifier = "a".repeat(64); const challenge = createHash("sha256").update(verifier).digest("base64url"); const clientId = "https://test.client/client.json"; const redirectUri = "https://test.client/callback";
    const request = oauth.validateAuthorizationRequest({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, resource: config.publicBaseUrl, code_challenge: challenge, code_challenge_method: "S256", scope: "catalog:read intents:create" });
    const redirect = new URL(await oauth.authorize(buyer.id, request)); const code = redirect.searchParams.get("code")!;
    await expect(oauth.exchangeCode({ code, codeVerifier: "wrong", clientId, redirectUri, resource: config.publicBaseUrl })).rejects.toMatchObject({ code: "invalid_grant" });
    const tokens = await oauth.exchangeCode({ code, codeVerifier: verifier, clientId, redirectUri, resource: config.publicBaseUrl });
    await expect(oauth.exchangeCode({ code, codeVerifier: verifier, clientId, redirectUri, resource: config.publicBaseUrl })).rejects.toMatchObject({ code: "invalid_grant" });
    expect((await oauth.authenticate(tokens.access_token, "intents:create"))?.userId).toBe(buyer.id);
    const rotated = await oauth.refresh({ refreshToken: tokens.refresh_token, clientId, resource: config.publicBaseUrl }); expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    await expect(oauth.refresh({ refreshToken: tokens.refresh_token, clientId, resource: config.publicBaseUrl })).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await oauth.authenticate(rotated.access_token)).toBeNull();
  });
});
