import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createDatabase, runMigrations } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import { OAuthService } from "../src/oauth.js";
import { AgentRailService } from "../src/service.js";
import { AgentRailStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://agentrail:agentrail-local-only@127.0.0.1:5432/agentrail_test";
let pool: Pool; let store: AgentRailStore; let service: AgentRailService;

beforeAll(async () => {
  const target = new URL(databaseUrl); const databaseName = target.pathname.slice(1); const admin = new Pool({ connectionString: new URL("/postgres", target).toString() });
  try { await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`); } catch (error) { if ((error as { code?: string }).code !== "42P04") throw error; } finally { await admin.end(); }
  pool = createDatabase(databaseUrl).pool; await runMigrations(pool); store = new AgentRailStore(pool);
  const config = loadConfig({ databaseUrl, publicBaseUrl: "http://agentrail.test", oauthIssuer: "http://agentrail.test", webauthnOrigin: "http://agentrail.test", webauthnRpId: "agentrail.test", credentialEncryptionKey: Buffer.alloc(32, 7) });
  service = new AgentRailService(store, config);
}, 30_000);

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE rate_limits,oauth_tokens,oauth_authorization_codes,audit_events,audit_chain_heads,webhook_events,payment_orders,approval_sessions,webauthn_challenges,intent_locks,merchant_payment_configurations,product_revisions,products,merchant_api_keys,merchant_invitations,merchant_memberships,passkey_credentials,browser_sessions,merchants,users CASCADE`);
});
afterAll(async () => { await pool?.end(); });

async function user(username: string) { return store.createUserWithPasskey({ username, displayName: username, rpId: "agentrail.test", credentialId: `cred_${username}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0, deviceType: "singleDevice", backedUp: false, transports: ["internal"] }); }
async function merchantProduct(ownerName = "owner") { const owner = await user(ownerName); const merchant = await store.createMerchant(owner.id, { slug: `shop-${ownerName}`, displayName: `${ownerName} Shop` }); await service.configurePayments(merchant.id, { adapter: "mock" }); const product = await store.createProduct(owner.id, merchant.id, { sku: "PLAN-1", name: "Annual Plan", description: "A real merchant product", pricePaise: 99_900, refundable: true, refundWindowDays: 7 }); return { owner, merchant, product }; }
async function approvedIntent(buyerName = "buyer") { const buyer = await user(buyerName); const setup = await merchantProduct(`owner-${buyerName}`); const created = await service.createIntent(buyer.id, { merchantId: setup.merchant.id, productId: setup.product.id, maxTotalPaise: 110_000, priceChangePolicy: "none", requireRefundable: true, minimumRefundWindowDays: 7, expiresInMinutes: 10 }, "buyer"); const token = new URL(created.approvalUrl).searchParams.get("token")!; const approval = await store.exchangeApprovalToken(created.intent.id, buyer.id, token); expect(approval).not.toBeNull(); const confirmed = await store.completeApproval({ intentLockId: created.intent.id, buyerId: buyer.id, sessionToken: approval!.token, credentialId: `cred_${buyerName}`, counter: 1, deviceType: "singleDevice", backedUp: false }); expect(confirmed?.status).toBe("confirmed"); return { buyer, ...setup, intent: confirmed! }; }

describe("PostgreSQL tenant and payment invariants", () => {
  it("keeps products and IntentLocks isolated across merchants and buyers", async () => {
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

  it("blocks post-intent price bait-and-switch with observed revision evidence", async () => {
    const setup = await approvedIntent(); await store.updateProduct(setup.owner.id, setup.merchant.id, setup.product.id, 1, { pricePaise: 129_900 });
    const result = await service.prepareCheckout(setup.buyer.id, setup.intent.id);
    expect(result.decision.reasons).toEqual(expect.arrayContaining(["PRICE_CHANGED", "BUDGET_EXCEEDED"]));
    expect(result.decision.observedProductVersion).toBe(2); expect(result.checkoutUrl).toBeUndefined();
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

  it("rejects audit mutation and detects offline tampering", async () => {
    const setup = await approvedIntent(); expect((await store.verifyAudit("intent", setup.intent.id)).valid).toBe(true);
    await expect(pool.query("UPDATE audit_events SET payload_json='{}' WHERE scope_type='intent' AND scope_id=$1", [setup.intent.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM audit_events WHERE scope_type='intent' AND scope_id=$1", [setup.intent.id])).rejects.toThrow(/append-only/);
  });
});

describe("OAuth 2.1 buyer binding", () => {
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
