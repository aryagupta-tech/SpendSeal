import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { MCP_SCOPES } from "@spendseal/core";
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
  await pool.query(`TRUNCATE TABLE rate_limits,oauth_tokens,oauth_authorization_codes,audit_events,audit_chain_heads,webhook_events,payment_orders,approval_sessions,webauthn_challenges,intent_locks,merchant_payment_configurations,product_revisions,products,merchant_api_keys,merchant_invitations,merchant_memberships,passkey_credentials,browser_sessions,merchants,users CASCADE`);
});
afterAll(async () => { await pool?.end(); });
afterEach(() => vi.unstubAllGlobals());

async function user(username: string) { return store.createUserWithPasskey({ username, displayName: username, rpId: "agentrail.test", credentialId: `cred_${username}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0, deviceType: "singleDevice", backedUp: false, transports: ["internal"] }); }
async function merchantProduct(ownerName = "owner") { const owner = await user(ownerName); const merchant = await store.createMerchant(owner.id, { slug: `shop-${ownerName}`, displayName: `${ownerName} Shop` }); await service.configurePayments(merchant.id, { adapter: "mock" }); const product = await store.createProduct(owner.id, merchant.id, { sku: "PLAN-1", name: "Annual Plan", description: "A real merchant product", pricePaise: 99_900, refundable: true, refundWindowDays: 7 }); return { owner, merchant, product }; }
async function approvedIntent(buyerName = "buyer") { const buyer = await user(buyerName); const setup = await merchantProduct(`owner-${buyerName}`); const created = await service.createIntent(buyer.id, { merchantId: setup.merchant.id, productId: setup.product.id, maxTotalPaise: 110_000, priceChangePolicy: "none", requireRefundable: true, minimumRefundWindowDays: 7, expiresInMinutes: 10 }, "buyer"); const token = new URL(created.approvalUrl).searchParams.get("token")!; const approval = await store.exchangeApprovalToken(created.intent.id, buyer.id, token); expect(approval).not.toBeNull(); const confirmed = await store.completeApproval({ purchasePermitId: created.intent.id, buyerId: buyer.id, sessionToken: approval!.token, credentialId: `cred_${buyerName}`, counter: 1, deviceType: "singleDevice", backedUp: false }); expect(confirmed?.status).toBe("confirmed"); return { buyer, ...setup, intent: confirmed! }; }

describe("PostgreSQL tenant and payment invariants", () => {
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
    await browserAgent.selectCandidate(task.id, buyer.id, candidates[0]!.id);
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
      deliveryDate: null,
      maskedAddressLabel: "PIN ••••01",
      addressFingerprint: "address-fingerprint",
      paymentMethodType: "saved_card",
      observedAt: new Date().toISOString(),
      adapterId: "amazon_in" as const,
      adapterVersion: "1.0.0",
      evidenceAssurance: "browser_observed" as const,
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
    expect(() => oauth.validateAuthorizationRequest({ response_type: "code", client_id: "https://chatgpt.com/oauth/client.json", redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", resource: config.publicBaseUrl, code_challenge: "challenge", code_challenge_method: "S256", scope: "browser:tasks:read" })).toThrowError(/scope/i);
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
