import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  hashAuditPayload,
  sha256,
  type AuditActor,
  type AuditEvent,
  type AiCommerceEventType,
  type AiCommerceSource,
  type MerchantAiSalesSummary,
  type PurchasePermit,
  type Merchant,
  type MerchantReadiness,
  type MerchantStorefront,
  type PaymentOrder,
  type Product,
  type ReasonCode,
  type User,
} from "@spendseal/core";
import { transaction } from "./db/client.js";
import type { ShopifyCatalogItem } from "./shopify.js";

type Queryable = { query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> };

export type SessionPrincipal = { user: User; csrfHash: string; tokenHash: string };
export type StoredPasskey = { id: string; userId: string; rpId: string; publicKey: Uint8Array; counter: number; deviceType: string; backedUp: boolean; transports: string[] };
export type StoredChallenge = { id: string; userId: string | null; purchasePermitId: string | null; shoppingTaskId: string | null; purpose: string; challenge: string; context: Record<string, unknown> };
export type PaymentConfiguration = { merchantId: string; adapter: "mock" | "razorpay"; keyId: string | null; keySecretCiphertext: string | null; webhookSecretCiphertext: string | null; encryptionKeyVersion: number; version: number };
export type CatalogConnection = { merchantId: string; provider: "shopify"; shopDomain: string; accessTokenCiphertext: string; encryptionKeyVersion: number; status: "active" | "error" | "revoked"; shopName: string; currency: string; defaultRefundable: boolean; defaultRefundWindowDays: number; lastSyncAt: string | null };
export type MerchantRole = "owner" | "admin" | "catalog_manager" | "auditor";
export type MerchantListing = Merchant & { role?: MerchantRole };
export type ShopifyProductReference = { externalId: string; externalUpdatedAt: string | null };
export type AiCommerceEventInput = { merchantId: string; eventType: AiCommerceEventType; source: AiCommerceSource; deduplicationKey: string; productId?: string | null; purchasePermitId?: string | null; paymentOrderId?: string | null; metricValue?: number };

export class SpendSealStore {
  constructor(readonly pool: Pool) {}

  async health(): Promise<void> { await this.pool.query("SELECT 1"); }

  async createChallenge(input: { userId?: string | null; purchasePermitId?: string | null; shoppingTaskId?: string | null; purpose: "registration" | "login" | "approval" | "shopping_approval"; challenge: string; context?: Record<string, unknown> }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(`INSERT INTO webauthn_challenges(id,user_id,intent_lock_id,shopping_task_id,purpose,challenge,context_json,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')`, [id, input.userId ?? null, input.purchasePermitId ?? null, input.shoppingTaskId ?? null, input.purpose, input.challenge, input.context ?? {}]);
    return id;
  }

  async consumeChallenge(input: { id: string; purpose: string; userId?: string | null; purchasePermitId?: string | null; shoppingTaskId?: string | null }): Promise<StoredChallenge | null> {
    return transaction(this.pool, async (client) => {
      const found = await client.query(`SELECT * FROM webauthn_challenges WHERE id=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [input.id, input.purpose]);
      const row = found.rows[0];
      if (!row || (input.userId !== undefined && row.user_id !== input.userId) || (input.purchasePermitId !== undefined && row.intent_lock_id !== input.purchasePermitId) || (input.shoppingTaskId !== undefined && row.shopping_task_id !== input.shoppingTaskId)) return null;
      await client.query("UPDATE webauthn_challenges SET consumed_at=now() WHERE id=$1", [input.id]);
      return { id: row.id, userId: row.user_id, purchasePermitId: row.intent_lock_id, shoppingTaskId: row.shopping_task_id, purpose: row.purpose, challenge: row.challenge, context: row.context_json ?? {} };
    });
  }

  async getUser(id: string): Promise<User | null> {
    const result = await this.pool.query("SELECT * FROM users WHERE id=$1", [id]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const result = await this.pool.query("SELECT * FROM users WHERE lower(username)=lower($1)", [username]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async createUserWithPasskey(input: { username: string; displayName: string; rpId: string; credentialId: string; publicKey: Uint8Array; counter: number; deviceType: string; backedUp: boolean; transports: string[] }): Promise<User> {
    return transaction(this.pool, async (client) => {
      const id = randomUUID();
      const userResult = await client.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,$3) RETURNING *", [id, input.username.toLowerCase(), input.displayName]);
      await client.query(`INSERT INTO passkey_credentials(credential_id,user_id,rp_id,public_key_b64,counter,device_type,backed_up,transports_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [input.credentialId, id, input.rpId, Buffer.from(input.publicKey).toString("base64"), input.counter, input.deviceType, input.backedUp, JSON.stringify(input.transports)]);
      return mapUser(userResult.rows[0]);
    });
  }

  async listPasskeys(userId: string, rpId: string): Promise<StoredPasskey[]> {
    const result = await this.pool.query("SELECT * FROM passkey_credentials WHERE user_id=$1 AND rp_id=$2 ORDER BY created_at", [userId, rpId]);
    return result.rows.map(mapPasskey);
  }

  async getPasskey(credentialId: string, rpId: string): Promise<StoredPasskey | null> {
    const result = await this.pool.query("SELECT * FROM passkey_credentials WHERE credential_id=$1 AND rp_id=$2", [credentialId, rpId]);
    return result.rows[0] ? mapPasskey(result.rows[0]) : null;
  }

  async updatePasskeyCounter(credentialId: string, counter: number): Promise<void> {
    await this.pool.query("UPDATE passkey_credentials SET counter=$2 WHERE credential_id=$1", [credentialId, counter]);
  }

  async createSession(userId: string, idleMinutes: number, absoluteHours: number): Promise<{ token: string; csrf: string }> {
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    await this.pool.query(`INSERT INTO browser_sessions(token_hash,user_id,csrf_hash,idle_expires_at,absolute_expires_at,last_seen_at)
      VALUES($1,$2,$3,now()+($4||' minutes')::interval,now()+($5||' hours')::interval,now())`, [sha256(token), userId, sha256(csrf), idleMinutes, absoluteHours]);
    return { token, csrf };
  }

  async getSession(token: string, idleMinutes: number): Promise<SessionPrincipal | null> {
    const hash = sha256(token);
    const result = await this.pool.query(`UPDATE browser_sessions s SET last_seen_at=now(),idle_expires_at=LEAST(absolute_expires_at,now()+($2||' minutes')::interval)
      FROM users u WHERE s.token_hash=$1 AND s.user_id=u.id AND s.idle_expires_at>now() AND s.absolute_expires_at>now() AND u.status='active'
      RETURNING u.*,s.csrf_hash,s.token_hash`, [hash, idleMinutes]);
    return result.rows[0] ? { user: mapUser(result.rows[0]), csrfHash: result.rows[0].csrf_hash, tokenHash: result.rows[0].token_hash } : null;
  }

  async deleteSession(token: string): Promise<void> { await this.pool.query("DELETE FROM browser_sessions WHERE token_hash=$1", [sha256(token)]); }

  async createMerchant(userId: string, input: { slug: string; displayName: string }): Promise<Merchant> {
    return transaction(this.pool, async (client) => {
      const id = randomUUID();
      const result = await client.query("INSERT INTO merchants(id,slug,display_name) VALUES($1,$2,$3) RETURNING *", [id, input.slug, input.displayName]);
      await client.query("INSERT INTO merchant_memberships(merchant_id,user_id,role) VALUES($1,$2,'owner')", [id, userId]);
      await this.appendAudit({ scopeType: "merchant", scopeId: id, merchantId: id, purchasePermitId: null, eventType: "MERCHANT_CREATED", actor: "merchant", reasonCode: null, payload: { displayName: input.displayName, slug: input.slug, ownerUserId: userId } }, client);
      return mapMerchant(result.rows[0]);
    });
  }

  async listMerchants(input: { query?: string; userId?: string; limit?: number; cursor?: string }): Promise<{ merchants: MerchantListing[]; nextCursor: string | null }> {
    const values: unknown[] = [];
    const where: string[] = ["m.status='active'"];
    if (input.query) { values.push(`%${input.query}%`); where.push(`(m.display_name ILIKE $${values.length} OR m.slug ILIKE $${values.length})`); }
    let membershipParameter: number | null = null;
    if (input.userId) { values.push(input.userId); membershipParameter = values.length; where.push(`EXISTS(SELECT 1 FROM merchant_memberships mm WHERE mm.merchant_id=m.id AND mm.user_id=$${values.length})`); }
    if (input.cursor) { values.push(input.cursor); where.push(`m.id::text>$${values.length}`); }
    const limit = Math.min(input.limit ?? 50, 100); values.push(limit + 1);
    const roleSelection = membershipParameter ? `(SELECT mm.role FROM merchant_memberships mm WHERE mm.merchant_id=m.id AND mm.user_id=$${membershipParameter}) AS membership_role` : `NULL::text AS membership_role`;
    const result = await this.pool.query(`SELECT m.*,${roleSelection} FROM merchants m WHERE ${where.join(" AND ")} ORDER BY m.id LIMIT $${values.length}`, values);
    const rows = result.rows.slice(0, limit);
    return { merchants: rows.map((row) => ({ ...mapMerchant(row), ...(row.membership_role ? { role: row.membership_role as MerchantRole } : {}) })), nextCursor: result.rows.length > limit ? rows.at(-1)!.id : null };
  }

  async getMerchant(id: string): Promise<Merchant | null> { const result = await this.pool.query("SELECT * FROM merchants WHERE id=$1", [id]); return result.rows[0] ? mapMerchant(result.rows[0]) : null; }

  async getMerchantBySlug(slug: string): Promise<Merchant | null> {
    const result = await this.pool.query("SELECT * FROM merchants WHERE lower(slug)=lower($1) AND status='active'", [slug]);
    return result.rows[0] ? mapMerchant(result.rows[0]) : null;
  }

  async recordAiCommerceEvent(input: AiCommerceEventInput, db: Queryable = this.pool): Promise<boolean> {
    const result = await db.query(`INSERT INTO merchant_ai_commerce_events(id,merchant_id,product_id,purchase_permit_id,payment_order_id,event_type,source,metric_value,deduplication_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(merchant_id,deduplication_key) DO NOTHING`, [randomUUID(), input.merchantId, input.productId ?? null, input.purchasePermitId ?? null, input.paymentOrderId ?? null, input.eventType, input.source, input.metricValue ?? 1, input.deduplicationKey]);
    return Boolean(result.rowCount);
  }

  async recordCatalogDiscovery(merchantId: string, buyerId: string, productCount: number, channel: "storefront" | "product_list", query?: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10); const buyerFingerprint = sha256(buyerId).slice(0, 20); const queryFingerprint = sha256(query?.trim().toLowerCase() || "all").slice(0, 16);
    const key = `${channel}:${buyerFingerprint}:${queryFingerprint}:${day}`;
    await this.recordAiCommerceEvent({ merchantId, eventType: "CATALOG_DISCOVERED", source: "chatgpt_mcp", deduplicationKey: `catalog:${key}` });
    await this.recordAiCommerceEvent({ merchantId, eventType: "PRODUCTS_PRESENTED", source: "chatgpt_mcp", deduplicationKey: `products:${key}`, metricValue: productCount });
  }

  async merchantReadiness(merchantId: string): Promise<MerchantReadiness> {
    const merchant = await this.getMerchant(merchantId); if (!merchant) throw new Error("MERCHANT_NOT_FOUND");
    const [productsResult, connection, payment, webhookResult, paidResult] = await Promise.all([
      this.pool.query("SELECT COUNT(*)::int AS count FROM products WHERE merchant_id=$1 AND active=true", [merchantId]),
      this.catalogConnection(merchantId), this.paymentConfig(merchantId),
      this.pool.query("SELECT COUNT(*)::int AS count FROM webhook_events WHERE merchant_id=$1", [merchantId]),
      this.pool.query(`SELECT COUNT(*)::int AS count FROM payment_orders po JOIN merchant_payment_configurations pc ON pc.merchant_id=po.merchant_id AND pc.version=po.payment_config_version WHERE po.merchant_id=$1 AND po.status='paid' AND pc.adapter='razorpay'`, [merchantId]),
    ]);
    const productsAvailable = Number(productsResult.rows[0]?.count ?? 0); const shopifyConnected = connection?.provider === "shopify" && connection.status === "active";
    const razorpayTestModeConnected = payment?.adapter === "razorpay" && Boolean(payment.keyId && payment.keySecretCiphertext); const webhookConfigured = razorpayTestModeConnected && Boolean(payment?.webhookSecretCiphertext);
    const webhookStatus: MerchantReadiness["webhookStatus"] = Number(webhookResult.rows[0]?.count ?? 0) > 0 ? "verified" : webhookConfigured ? "configured_unverified" : "not_configured";
    const transactable = productsAvailable > 0 && shopifyConnected && razorpayTestModeConnected && webhookConfigured;
    const status: MerchantReadiness["status"] = transactable && Number(paidResult.rows[0]?.count ?? 0) > 0 ? "payment_verified" : transactable ? "ai_transactable" : productsAvailable > 0 ? "catalog_ready" : "not_ready";
    return { status, merchantId, merchantSlug: merchant.slug, merchantName: merchant.displayName, shopifyConnected, razorpayTestModeConnected, productsAvailable, chatGptConnectionAvailable: true, webhookStatus, samplePrompt: `Open SpendSeal, find a product from ${merchant.displayName}. My hard maximum is INR 45. Negotiate the best protected deal and prepare it for my approval.`, evidenceAssurance: razorpayTestModeConnected ? "provider_verified" : "merchant_managed" };
  }

  async merchantStorefront(merchantSlug: string, buyerId: string): Promise<MerchantStorefront | null> {
    const merchant = await this.getMerchantBySlug(merchantSlug); if (!merchant) return null;
    const [{ products }, readiness, policies] = await Promise.all([this.listProducts(merchant.id, undefined, 100), this.merchantReadiness(merchant.id), this.pool.query(`SELECT DISTINCT ON (product_id) product_id,active FROM merchant_deal_policies WHERE merchant_id=$1 ORDER BY product_id,version DESC`, [merchant.id])]);
    await this.recordCatalogDiscovery(merchant.id, buyerId, products.length, "storefront");
    const enabled = new Set(policies.rows.filter((row) => row.active).map((row) => row.product_id));
    return { merchant: { id: merchant.id, slug: merchant.slug, displayName: merchant.displayName, status: merchant.status }, products: products.map((product) => ({ ...product, negotiationAvailable: enabled.has(product.id) })), supportedCurrency: "INR", refundTermsAuthority: "merchant_stated", checkout: { purchasePermitAvailable: products.length > 0, buyerPasskeyRequired: true, razorpayTestModeAvailable: readiness.razorpayTestModeConnected, evidenceAssurance: readiness.evidenceAssurance, livePaymentMode: "test" }, readiness };
  }

  async merchantAiSalesSummary(merchantId: string): Promise<MerchantAiSalesSummary> {
    const [eventsResult, paymentsResult, blockedResult, topResult, dealResult, negotiatedPaymentsResult, topNegotiatedResult] = await Promise.all([
      this.pool.query(`WITH ai_permits AS (SELECT purchase_permit_id FROM merchant_ai_commerce_events WHERE merchant_id=$1 AND event_type='PURCHASE_PERMIT_CREATED' AND source='chatgpt_mcp') SELECT e.event_type,COUNT(*)::int AS count,COALESCE(SUM(e.metric_value),0)::int AS value FROM merchant_ai_commerce_events e WHERE e.merchant_id=$1 AND (e.event_type IN ('CATALOG_DISCOVERED','PRODUCTS_PRESENTED') OR e.purchase_permit_id IN (SELECT purchase_permit_id FROM ai_permits)) GROUP BY e.event_type`, [merchantId]),
      this.pool.query(`SELECT COUNT(*) FILTER(WHERE po.provider_order_id IS NOT NULL)::int AS orders_created,COUNT(*) FILTER(WHERE po.status='paid')::int AS payments_verified,COALESCE(SUM(po.amount_paise) FILTER(WHERE po.status='paid'),0)::bigint AS test_gmv FROM payment_orders po JOIN merchant_payment_configurations pc ON pc.merchant_id=po.merchant_id AND pc.version=po.payment_config_version JOIN merchant_ai_commerce_events origin ON origin.merchant_id=po.merchant_id AND origin.purchase_permit_id=po.intent_lock_id AND origin.event_type='PURCHASE_PERMIT_CREATED' AND origin.source='chatgpt_mcp' WHERE po.merchant_id=$1 AND pc.adapter='razorpay'`, [merchantId]),
      this.pool.query(`SELECT COUNT(*)::int AS count FROM merchant_ai_commerce_events e JOIN merchant_ai_commerce_events origin ON origin.merchant_id=e.merchant_id AND origin.purchase_permit_id=e.purchase_permit_id AND origin.event_type='PURCHASE_PERMIT_CREATED' AND origin.source='chatgpt_mcp' WHERE e.merchant_id=$1 AND e.event_type IN ('POLICY_DENIED','REPLAY_BLOCKED')`, [merchantId]),
      this.pool.query(`SELECT p.id AS product_id,p.name,COUNT(*)::int AS selections FROM merchant_ai_commerce_events e JOIN products p ON p.id=e.product_id AND p.merchant_id=e.merchant_id WHERE e.merchant_id=$1 AND e.event_type='PURCHASE_PERMIT_CREATED' AND e.source='chatgpt_mcp' GROUP BY p.id,p.name ORDER BY selections DESC,p.name LIMIT 5`, [merchantId]),
      this.pool.query(`SELECT COUNT(*)::int AS started,COUNT(*) FILTER(WHERE accepted_price_paise IS NOT NULL)::int AS accepted,COUNT(*) FILTER(WHERE status='rejected')::int AS rejected,COALESCE(AVG(round_count),0)::numeric AS average_rounds,COALESCE(AVG(CASE WHEN accepted_price_paise IS NOT NULL THEN (public_price_paise-accepted_price_paise)::numeric*100/public_price_paise END),0)::numeric AS average_concession FROM deal_sessions WHERE merchant_id=$1`, [merchantId]),
      this.pool.query(`SELECT COUNT(*)::int AS payments,COUNT(*) FILTER(WHERE ds.public_price_paise>ds.buyer_max_total_paise)::int AS recovered_orders,COALESCE(SUM(po.amount_paise) FILTER(WHERE ds.public_price_paise>ds.buyer_max_total_paise),0)::bigint AS recovered_gmv FROM deal_sessions ds JOIN intent_locks i ON i.id=ds.purchase_permit_id JOIN payment_orders po ON po.intent_lock_id=i.id JOIN merchant_payment_configurations pc ON pc.merchant_id=po.merchant_id AND pc.version=po.payment_config_version WHERE ds.merchant_id=$1 AND ds.status='paid' AND po.status='paid' AND pc.adapter='razorpay'`, [merchantId]),
      this.pool.query(`SELECT p.id AS product_id,p.name,COUNT(*)::int AS negotiations FROM deal_sessions ds JOIN products p ON p.id=ds.product_id AND p.merchant_id=ds.merchant_id WHERE ds.merchant_id=$1 GROUP BY p.id,p.name ORDER BY negotiations DESC,p.name LIMIT 5`, [merchantId]),
    ]);
    const counts = new Map<string, { count: number; value: number }>(eventsResult.rows.map((row) => [row.event_type, { count: Number(row.count), value: Number(row.value) }]));
    const eventCount = (type: string) => counts.get(type)?.count ?? 0; const eventValue = (type: string) => counts.get(type)?.value ?? 0;
    const purchasePermitsCreated = eventCount("PURCHASE_PERMIT_CREATED"); const passkeyApprovals = eventCount("PASSKEY_APPROVED"); const paymentsVerified = Number(paymentsResult.rows[0]?.payments_verified ?? 0);
    const rate = (numerator: number, denominator: number) => denominator ? Math.round(numerator / denominator * 1000) / 10 : 0;
    const deals = dealResult.rows[0] ?? {}; const negotiatedPayments = negotiatedPaymentsResult.rows[0] ?? {};
    return { catalogDiscoveries: eventCount("CATALOG_DISCOVERED"), productsShown: eventValue("PRODUCTS_PRESENTED"), purchasePermitsCreated, passkeyApprovals, policyAllowedCheckouts: eventCount("POLICY_ALLOWED"), policyDenials: eventCount("POLICY_DENIED"), razorpayTestOrdersCreated: Number(paymentsResult.rows[0]?.orders_created ?? 0), razorpayTestPaymentsVerified: paymentsVerified, testGmvPaise: Number(paymentsResult.rows[0]?.test_gmv ?? 0), safelyStoppedPurchases: Number(blockedResult.rows[0]?.count ?? 0), permitToApprovalRate: rate(passkeyApprovals, purchasePermitsCreated), approvalToPaymentRate: rate(paymentsVerified, passkeyApprovals), topProducts: topResult.rows.map((row) => ({ productId: row.product_id, name: row.name, selections: Number(row.selections) })), negotiationsStarted: Number(deals.started ?? 0), dealsAccepted: Number(deals.accepted ?? 0), noDealOutcomes: Number(deals.rejected ?? 0), negotiatedPaymentsVerified: Number(negotiatedPayments.payments ?? 0), constraintRecoveredTestOrders: Number(negotiatedPayments.recovered_orders ?? 0), constraintRecoveredTestGmvPaise: Number(negotiatedPayments.recovered_gmv ?? 0), dealToPaymentRate: rate(Number(negotiatedPayments.payments ?? 0), Number(deals.accepted ?? 0)), averageNegotiationRounds: Math.round(Number(deals.average_rounds ?? 0) * 100) / 100, averagePublicPriceConcessionPercent: Math.round(Number(deals.average_concession ?? 0) * 100) / 100, topNegotiatedProducts: topNegotiatedResult.rows.map((row) => ({ productId: row.product_id, name: row.name, negotiations: Number(row.negotiations) })) };
  }

  async catalogConnection(merchantId: string): Promise<CatalogConnection | null> {
    const result = await this.pool.query("SELECT * FROM merchant_catalog_connections WHERE merchant_id=$1", [merchantId]);
    return result.rows[0] ? mapCatalogConnection(result.rows[0]) : null;
  }

  async saveShopifyConnection(input: Omit<CatalogConnection, "status" | "lastSyncAt">): Promise<CatalogConnection> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(`INSERT INTO merchant_catalog_connections(merchant_id,provider,shop_domain,access_token_ciphertext,encryption_key_version,status,shop_name,currency,default_refundable,default_refund_window_days)
        VALUES($1,'shopify',$2,$3,$4,'active',$5,$6,$7,$8)
        ON CONFLICT(merchant_id) DO UPDATE SET shop_domain=EXCLUDED.shop_domain,access_token_ciphertext=EXCLUDED.access_token_ciphertext,encryption_key_version=EXCLUDED.encryption_key_version,status='active',shop_name=EXCLUDED.shop_name,currency=EXCLUDED.currency,default_refundable=EXCLUDED.default_refundable,default_refund_window_days=EXCLUDED.default_refund_window_days,updated_at=now()
        RETURNING *`, [input.merchantId, input.shopDomain, input.accessTokenCiphertext, input.encryptionKeyVersion, input.shopName, input.currency, input.defaultRefundable, input.defaultRefundWindowDays]);
      await this.appendAudit({ scopeType: "merchant", scopeId: input.merchantId, merchantId: input.merchantId, purchasePermitId: null, eventType: "SHOPIFY_CATALOG_CONNECTED", actor: "merchant", reasonCode: null, payload: { provider: "shopify", shopDomain: input.shopDomain, shopName: input.shopName, currency: input.currency, scopes: ["read_products"], tokenStored: "aes-256-gcm" } }, client);
      return mapCatalogConnection(result.rows[0]);
    });
  }

  async syncShopifyProducts(userId: string, connection: CatalogConnection, items: ShopifyCatalogItem[]): Promise<{ created: number; updated: number; unchanged: number; archived: number; syncedAt: string }> {
    return transaction(this.pool, async (client) => {
      const syncedAt = new Date().toISOString(); let created = 0; let updated = 0; let unchanged = 0;
      const observedIds = items.map((item) => item.externalId);
      for (const item of items) {
        const existing = await client.query("SELECT * FROM products WHERE merchant_id=$1 AND external_id=$2 FOR UPDATE", [connection.merchantId, item.externalId]);
        const row = existing.rows[0];
        if (!row) {
          const id = randomUUID(); const revisionId = randomUUID();
          const snapshot = productSnapshot({ id, merchantId: connection.merchantId, sku: item.sku, name: item.name, description: item.description, pricePaise: item.pricePaise, refundable: connection.defaultRefundable, refundWindowDays: connection.defaultRefundWindowDays, active: item.active, version: 1, revisionId, catalogSource: "shopify_admin_graphql", shopDomain: connection.shopDomain, externalId: item.externalId, externalUpdatedAt: item.externalUpdatedAt });
          const snapshotHash = sha256(snapshot);
          await client.query(`INSERT INTO products(id,merchant_id,sku,name,description,price_paise,refundable,refund_window_days,active,version,current_revision_id,catalog_source,external_id,external_updated_at,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,'shopify_admin_graphql',$11,$12,$13,$13)`, [id, connection.merchantId, item.sku, item.name, item.description, item.pricePaise, connection.defaultRefundable, connection.defaultRefundWindowDays, item.active, revisionId, item.externalId, item.externalUpdatedAt, syncedAt]);
          await client.query("INSERT INTO product_revisions(id,merchant_id,product_id,version,snapshot_json,snapshot_hash,created_by,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$7)", [revisionId, connection.merchantId, id, snapshot, snapshotHash, userId, syncedAt]);
          created += 1; continue;
        }
        const changed = row.sku !== item.sku || row.name !== item.name || row.description !== item.description || row.price_paise !== item.pricePaise || row.active !== item.active || row.refundable !== connection.defaultRefundable || row.refund_window_days !== connection.defaultRefundWindowDays;
        if (!changed) { await client.query("UPDATE products SET external_updated_at=$3,updated_at=$4 WHERE merchant_id=$1 AND id=$2", [connection.merchantId, row.id, item.externalUpdatedAt, syncedAt]); unchanged += 1; continue; }
        const version = row.version + 1; const revisionId = randomUUID();
        const snapshot = productSnapshot({ id: row.id, merchantId: connection.merchantId, sku: item.sku, name: item.name, description: item.description, pricePaise: item.pricePaise, refundable: connection.defaultRefundable, refundWindowDays: connection.defaultRefundWindowDays, active: item.active, version, revisionId, catalogSource: "shopify_admin_graphql", shopDomain: connection.shopDomain, externalId: item.externalId, externalUpdatedAt: item.externalUpdatedAt });
        const snapshotHash = sha256(snapshot);
        await client.query("INSERT INTO product_revisions(id,merchant_id,product_id,version,snapshot_json,snapshot_hash,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [revisionId, connection.merchantId, row.id, version, snapshot, snapshotHash, userId, syncedAt]);
        await client.query(`UPDATE products SET sku=$3,name=$4,description=$5,price_paise=$6,refundable=$7,refund_window_days=$8,active=$9,version=$10,current_revision_id=$11,external_updated_at=$12,updated_at=$13 WHERE merchant_id=$1 AND id=$2`, [connection.merchantId, row.id, item.sku, item.name, item.description, item.pricePaise, connection.defaultRefundable, connection.defaultRefundWindowDays, item.active, version, revisionId, item.externalUpdatedAt, syncedAt]);
        updated += 1;
      }
      const stale = observedIds.length
        ? await client.query("SELECT * FROM products WHERE merchant_id=$1 AND catalog_source='shopify_admin_graphql' AND active=true AND NOT(external_id=ANY($2::text[])) FOR UPDATE", [connection.merchantId, observedIds])
        : await client.query("SELECT * FROM products WHERE merchant_id=$1 AND catalog_source='shopify_admin_graphql' AND active=true FOR UPDATE", [connection.merchantId]);
      for (const row of stale.rows) {
        const version = row.version + 1; const revisionId = randomUUID();
        const snapshot = productSnapshot({ id: row.id, merchantId: connection.merchantId, sku: row.sku, name: row.name, description: row.description, pricePaise: row.price_paise, refundable: row.refundable, refundWindowDays: row.refund_window_days, active: false, version, revisionId, catalogSource: "shopify_admin_graphql", shopDomain: connection.shopDomain, externalId: row.external_id, externalUpdatedAt: row.external_updated_at ? iso(row.external_updated_at) : null });
        await client.query("INSERT INTO product_revisions(id,merchant_id,product_id,version,snapshot_json,snapshot_hash,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [revisionId, connection.merchantId, row.id, version, snapshot, sha256(snapshot), userId, syncedAt]);
        await client.query("UPDATE products SET active=false,version=$3,current_revision_id=$4,updated_at=$5 WHERE merchant_id=$1 AND id=$2", [connection.merchantId, row.id, version, revisionId, syncedAt]);
      }
      const archived = stale.rowCount ?? 0;
      await client.query("UPDATE merchant_catalog_connections SET last_sync_at=$2,status='active',updated_at=$2 WHERE merchant_id=$1", [connection.merchantId, syncedAt]);
      await this.appendAudit({ scopeType: "merchant", scopeId: connection.merchantId, merchantId: connection.merchantId, purchasePermitId: null, eventType: "SHOPIFY_CATALOG_SYNCED", actor: "merchant", reasonCode: null, payload: { shopDomain: connection.shopDomain, observedVariants: items.length, created, updated, unchanged, archived, syncedAt } }, client);
      return { created, updated, unchanged, archived, syncedAt };
    });
  }

  async shopifyProductReference(merchantId: string, productId: string): Promise<ShopifyProductReference | null> {
    const result = await this.pool.query("SELECT external_id,external_updated_at FROM products WHERE merchant_id=$1 AND id=$2 AND catalog_source='shopify_admin_graphql'", [merchantId, productId]);
    const row = result.rows[0];
    return row?.external_id ? { externalId: row.external_id, externalUpdatedAt: row.external_updated_at ? iso(row.external_updated_at) : null } : null;
  }

  async refreshShopifyProductForPolicy(purchasePermitId: string, connection: CatalogConnection, observation: ShopifyCatalogItem | null): Promise<Product> {
    return transaction(this.pool, async (client) => {
      const intentResult = await client.query("SELECT * FROM intent_locks WHERE id=$1 FOR UPDATE", [purchasePermitId]);
      const intent = intentResult.rows[0];
      if (!intent || intent.merchant_id !== connection.merchantId) throw new Error("INTENT_NOT_FOUND");
      const productResult = await client.query("SELECT * FROM products WHERE merchant_id=$1 AND id=$2 AND catalog_source='shopify_admin_graphql' FOR UPDATE", [connection.merchantId, intent.product_id]);
      const row = productResult.rows[0];
      if (!row) throw new Error("SHOPIFY_PRODUCT_NOT_FOUND");
      const observedAt = new Date().toISOString();
      const item: ShopifyCatalogItem = observation ?? {
        externalId: row.external_id,
        sku: row.sku,
        name: row.name,
        description: row.description,
        pricePaise: row.price_paise,
        active: false,
        externalUpdatedAt: observedAt,
      };
      if (item.externalId !== row.external_id) throw new Error("SHOPIFY_PRODUCT_MISMATCH");
      const changed = row.sku !== item.sku || row.name !== item.name || row.description !== item.description || row.price_paise !== item.pricePaise || row.active !== item.active || row.refundable !== connection.defaultRefundable || row.refund_window_days !== connection.defaultRefundWindowDays;
      if (changed) {
        const version = row.version + 1; const revisionId = randomUUID();
        const snapshot = productSnapshot({ id: row.id, merchantId: connection.merchantId, sku: item.sku, name: item.name, description: item.description, pricePaise: item.pricePaise, refundable: connection.defaultRefundable, refundWindowDays: connection.defaultRefundWindowDays, active: item.active, version, revisionId, catalogSource: "shopify_admin_graphql", shopDomain: connection.shopDomain, externalId: item.externalId, externalUpdatedAt: item.externalUpdatedAt });
        await client.query("INSERT INTO product_revisions(id,merchant_id,product_id,version,snapshot_json,snapshot_hash,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,NULL,$7)", [revisionId, connection.merchantId, row.id, version, snapshot, sha256(snapshot), observedAt]);
        await client.query(`UPDATE products SET sku=$3,name=$4,description=$5,price_paise=$6,refundable=$7,refund_window_days=$8,active=$9,version=$10,current_revision_id=$11,external_updated_at=$12,updated_at=$13 WHERE merchant_id=$1 AND id=$2`, [connection.merchantId, row.id, item.sku, item.name, item.description, item.pricePaise, connection.defaultRefundable, connection.defaultRefundWindowDays, item.active, version, revisionId, item.externalUpdatedAt, observedAt]);
      } else {
        await client.query("UPDATE products SET external_updated_at=$3,updated_at=$4 WHERE merchant_id=$1 AND id=$2", [connection.merchantId, row.id, item.externalUpdatedAt, observedAt]);
      }
      await client.query("UPDATE merchant_catalog_connections SET last_sync_at=$2,status='active',updated_at=$2 WHERE merchant_id=$1", [connection.merchantId, observedAt]);
      const refreshed = await this.getProduct(connection.merchantId, row.id, client);
      if (!refreshed) throw new Error("SHOPIFY_PRODUCT_NOT_FOUND");
      await this.appendAudit({ scopeType: "intent", scopeId: purchasePermitId, merchantId: connection.merchantId, purchasePermitId, eventType: "AUTHORITATIVE_PRODUCT_REFRESHED", actor: "policy_engine", reasonCode: null, payload: { source: "shopify_admin_graphql", shopDomain: connection.shopDomain, externalIdHash: sha256(item.externalId), observedAt, productVersion: refreshed.version, productRevisionId: refreshed.revisionId, productSnapshotHash: refreshed.snapshotHash, observedPricePaise: refreshed.pricePaise, active: refreshed.active, changed } }, client);
      return refreshed;
    });
  }

  async requireMembership(userId: string, merchantId: string, roles?: string[]): Promise<string | null> {
    const result = await this.pool.query("SELECT role FROM merchant_memberships WHERE user_id=$1 AND merchant_id=$2", [userId, merchantId]);
    const role = result.rows[0]?.role as string | undefined;
    return role && (!roles || roles.includes(role)) ? role : null;
  }

  async listMemberships(merchantId: string): Promise<unknown[]> {
    return (await this.pool.query(`SELECT mm.user_id AS "userId",u.username,u.display_name AS "displayName",mm.role,mm.created_at AS "createdAt"
      FROM merchant_memberships mm JOIN users u ON u.id=mm.user_id WHERE mm.merchant_id=$1 ORDER BY mm.created_at`, [merchantId])).rows;
  }

  async createInvitation(merchantId: string, actorUserId: string, invitedUsername: string, role: "admin" | "catalog_manager" | "auditor"): Promise<{ id: string; token: string; expiresAt: string }> {
    return transaction(this.pool, async (client) => {
      const id = randomUUID(); const token = randomBytes(32).toString("base64url"); const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
      await client.query(`INSERT INTO merchant_invitations(id,merchant_id,invited_username,role,token_hash,created_by,expires_at)
        VALUES($1,$2,lower($3),$4,$5,$6,$7)`, [id, merchantId, invitedUsername, role, sha256(token), actorUserId, expiresAt]);
      await this.appendAudit({ scopeType: "merchant", scopeId: merchantId, merchantId, purchasePermitId: null, eventType: "MEMBERSHIP_INVITED", actor: "merchant", reasonCode: null, payload: { invitationId: id, invitedUsername: invitedUsername.toLowerCase(), role, expiresAt } }, client);
      return { id, token, expiresAt };
    });
  }

  async listInvitations(merchantId: string): Promise<unknown[]> {
    return (await this.pool.query(`SELECT id,invited_username AS "invitedUsername",role,expires_at AS "expiresAt",accepted_at AS "acceptedAt",revoked_at AS "revokedAt",created_at AS "createdAt"
      FROM merchant_invitations WHERE merchant_id=$1 ORDER BY created_at DESC`, [merchantId])).rows;
  }

  async acceptInvitation(user: User, token: string): Promise<{ merchantId: string; role: string } | null> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE merchant_invitations SET accepted_at=now() WHERE token_hash=$1 AND lower(invited_username)=lower($2)
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING *`, [sha256(token), user.username]);
      const invitation = result.rows[0]; if (!invitation) return null;
      await client.query(`INSERT INTO merchant_memberships(merchant_id,user_id,role) VALUES($1,$2,$3)
        ON CONFLICT(merchant_id,user_id) DO UPDATE SET role=EXCLUDED.role`, [invitation.merchant_id, user.id, invitation.role]);
      await this.appendAudit({ scopeType: "merchant", scopeId: invitation.merchant_id, merchantId: invitation.merchant_id, purchasePermitId: null, eventType: "MEMBERSHIP_ACCEPTED", actor: "merchant", reasonCode: null, payload: { invitationId: invitation.id, userId: user.id, role: invitation.role } }, client);
      return { merchantId: invitation.merchant_id, role: invitation.role };
    });
  }

  async updateMembershipRole(merchantId: string, actorUserId: string, targetUserId: string, role: "owner" | "admin" | "catalog_manager" | "auditor"): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const current = await client.query("SELECT role FROM merchant_memberships WHERE merchant_id=$1 AND user_id=$2 FOR UPDATE", [merchantId, targetUserId]);
      if (!current.rows[0]) return false;
      if (current.rows[0].role === "owner" && role !== "owner") {
        const owners = await client.query("SELECT count(*)::int AS count FROM merchant_memberships WHERE merchant_id=$1 AND role='owner'", [merchantId]);
        if (owners.rows[0].count <= 1) throw new Error("LAST_OWNER");
      }
      await client.query("UPDATE merchant_memberships SET role=$3 WHERE merchant_id=$1 AND user_id=$2", [merchantId, targetUserId, role]);
      await this.appendAudit({ scopeType: "merchant", scopeId: merchantId, merchantId, purchasePermitId: null, eventType: "MEMBERSHIP_ROLE_CHANGED", actor: "merchant", reasonCode: null, payload: { actorUserId, targetUserId, previousRole: current.rows[0].role, role } }, client);
      return true;
    });
  }

  async createProduct(userId: string, merchantId: string, input: { sku: string; name: string; description: string; pricePaise: number; refundable: boolean; refundWindowDays: number; active?: boolean }): Promise<Product> {
    return transaction(this.pool, async (client) => {
      const id = randomUUID(); const revisionId = randomUUID(); const now = new Date().toISOString();
      const snapshot = productSnapshot({ id, merchantId, sku: input.sku, name: input.name, description: input.description, pricePaise: input.pricePaise, refundable: input.refundable, refundWindowDays: input.refundWindowDays, active: input.active ?? true, version: 1, revisionId, catalogSource: "agentrail_server", shopDomain: null, externalId: null, externalUpdatedAt: null });
      const snapshotHash = sha256(snapshot);
      await client.query(`INSERT INTO products(id,merchant_id,sku,name,description,price_paise,refundable,refund_window_days,active,version,current_revision_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$11)`, [id, merchantId, input.sku, input.name, input.description, input.pricePaise, input.refundable, input.refundWindowDays, input.active ?? true, revisionId, now]);
      await client.query(`INSERT INTO product_revisions(id,merchant_id,product_id,version,snapshot_json,snapshot_hash,created_by,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$7)`, [revisionId, merchantId, id, snapshot, snapshotHash, userId, now]);
      const product = await this.getProduct(merchantId, id, client);
      await this.appendAudit({ scopeType: "merchant", scopeId: merchantId, merchantId, purchasePermitId: null, eventType: "PRODUCT_CREATED", actor: "merchant", reasonCode: null, payload: { product } }, client);
      return product!;
    });
  }

  async updateProduct(userId: string, merchantId: string, productId: string, expectedVersion: number, fields: Partial<{ sku: string; name: string; description: string; pricePaise: number; refundable: boolean; refundWindowDays: number; active: boolean }>): Promise<Product | "VERSION_CONFLICT" | null> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query("SELECT * FROM products WHERE merchant_id=$1 AND id=$2 FOR UPDATE", [merchantId, productId]);
      const row = locked.rows[0]; if (!row) return null; if (row.catalog_source === "shopify_admin_graphql") throw new Error("EXTERNAL_SOURCE"); if (row.version !== expectedVersion) return "VERSION_CONFLICT";
      const version = row.version + 1; const revisionId = randomUUID(); const now = new Date().toISOString();
      const next = { sku: fields.sku ?? row.sku, name: fields.name ?? row.name, description: fields.description ?? row.description, pricePaise: fields.pricePaise ?? row.price_paise, refundable: fields.refundable ?? row.refundable, refundWindowDays: fields.refundWindowDays ?? row.refund_window_days, active: fields.active ?? row.active };
      const snapshot = productSnapshot({ id: productId, merchantId, ...next, version, revisionId, catalogSource: "agentrail_server", shopDomain: null, externalId: null, externalUpdatedAt: null }); const snapshotHash = sha256(snapshot);
      await client.query(`INSERT INTO product_revisions(id,merchant_id,product_id,version,snapshot_json,snapshot_hash,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [revisionId, merchantId, productId, version, snapshot, snapshotHash, userId, now]);
      await client.query(`UPDATE products SET sku=$3,name=$4,description=$5,price_paise=$6,refundable=$7,refund_window_days=$8,active=$9,version=$10,current_revision_id=$11,updated_at=$12 WHERE merchant_id=$1 AND id=$2`, [merchantId, productId, next.sku, next.name, next.description, next.pricePaise, next.refundable, next.refundWindowDays, next.active, version, revisionId, now]);
      const product = await this.getProduct(merchantId, productId, client);
      await this.appendAudit({ scopeType: "merchant", scopeId: merchantId, merchantId, purchasePermitId: null, eventType: "PRODUCT_UPDATED", actor: "merchant", reasonCode: null, payload: { previousVersion: expectedVersion, product } }, client);
      return product;
    });
  }

  async listProducts(merchantId: string, query?: string, limit = 50, cursor?: string, includeArchived = false): Promise<{ products: Product[]; nextCursor: string | null }> {
    const values: unknown[] = [merchantId]; const where = ["p.merchant_id=$1"];
    if (!includeArchived) where.push("p.active=true");
    if (query) { values.push(`%${query}%`); where.push(`(p.name ILIKE $${values.length} OR p.description ILIKE $${values.length} OR p.sku ILIKE $${values.length})`); }
    if (cursor) { values.push(cursor); where.push(`p.id::text>$${values.length}`); }
    const capped = Math.min(limit, 100); values.push(capped + 1);
    const result = await this.pool.query(`SELECT p.*,pr.snapshot_hash,mc.shop_domain FROM products p JOIN product_revisions pr ON pr.id=p.current_revision_id LEFT JOIN merchant_catalog_connections mc ON mc.merchant_id=p.merchant_id WHERE ${where.join(" AND ")} ORDER BY p.id LIMIT $${values.length}`, values);
    const rows = result.rows.slice(0, capped);
    return { products: rows.map(mapProduct), nextCursor: result.rows.length > capped ? rows.at(-1)!.id : null };
  }

  async getProduct(merchantId: string, productId: string, db: Queryable = this.pool): Promise<Product | null> {
    const result = await db.query("SELECT p.*,pr.snapshot_hash,mc.shop_domain FROM products p JOIN product_revisions pr ON pr.id=p.current_revision_id LEFT JOIN merchant_catalog_connections mc ON mc.merchant_id=p.merchant_id WHERE p.merchant_id=$1 AND p.id=$2", [merchantId, productId]);
    return result.rows[0] ? mapProduct(result.rows[0]) : null;
  }

  async productRevisions(merchantId: string, productId: string): Promise<unknown[]> {
    const result = await this.pool.query("SELECT id,version,snapshot_json AS snapshot,snapshot_hash AS \"snapshotHash\",created_at AS \"createdAt\" FROM product_revisions WHERE merchant_id=$1 AND product_id=$2 ORDER BY version DESC", [merchantId, productId]);
    return result.rows;
  }

  async createIntent(buyerId: string, product: Product, input: { maxTotalPaise: number; priceChangePolicy: string; requireRefundable: boolean; minimumRefundWindowDays: number | null; expiresAt: string }, source: "chatgpt_mcp" | "buyer_web" = "chatgpt_mcp"): Promise<{ intent: PurchasePermit; approvalToken: string }> {
    return transaction(this.pool, async (client) => {
      const id = randomUUID(); const approvalToken = randomBytes(32).toString("base64url"); const createdAt = new Date().toISOString();
      await client.query(`INSERT INTO intent_locks(id,buyer_id,merchant_id,product_id,product_revision_id,product_snapshot_hash,locked_unit_price_paise,max_total_paise,price_change_policy,require_refundable,minimum_refund_window_days,expires_at,idempotency_key,approval_token_hash,status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending_confirmation',$15)`, [id, buyerId, product.merchantId, product.id, product.revisionId, product.snapshotHash, product.pricePaise, input.maxTotalPaise, input.priceChangePolicy, input.requireRefundable, input.minimumRefundWindowDays, input.expiresAt, `intent_${randomUUID()}`, sha256(approvalToken), createdAt]);
      const intent = await this.getIntent(id, buyerId, client);
      await this.appendAudit({ scopeType: "intent", scopeId: id, merchantId: product.merchantId, purchasePermitId: id, eventType: "PURCHASE_PERMIT_CREATED", actor: source === "buyer_web" ? "buyer" : "chatgpt", reasonCode: null, payload: { intent, authorizedProduct: product } }, client);
      await this.recordAiCommerceEvent({ merchantId: product.merchantId, productId: product.id, purchasePermitId: id, eventType: "PURCHASE_PERMIT_CREATED", source, deduplicationKey: `permit:${id}` }, client);
      return { intent: intent!, approvalToken };
    });
  }

  async getIntent(id: string, buyerId?: string, db: Queryable = this.pool, lock = false): Promise<PurchasePermit | null> {
    const values: unknown[] = [id]; let where = "id=$1";
    if (buyerId) { values.push(buyerId); where += " AND buyer_id=$2"; }
    const result = await db.query(`SELECT * FROM intent_locks WHERE ${where}${lock ? " FOR UPDATE" : ""}`, values);
    return result.rows[0] ? mapIntent(result.rows[0]) : null;
  }

  async listBuyerIntents(buyerId: string): Promise<PurchasePermit[]> {
    const result = await this.pool.query("SELECT * FROM intent_locks WHERE buyer_id=$1 ORDER BY created_at DESC LIMIT 100", [buyerId]);
    return result.rows.map(mapIntent);
  }

  async exchangeApprovalToken(purchasePermitId: string, buyerId: string, token: string): Promise<{ token: string; expiresAt: string } | null> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE intent_locks SET approval_token_exchanged_at=now() WHERE id=$1 AND buyer_id=$2 AND approval_token_hash=$3 AND approval_token_exchanged_at IS NULL AND status='pending_confirmation' AND expires_at>now() RETURNING *`, [purchasePermitId, buyerId, sha256(token)]);
      if (!result.rows[0]) return null;
      const sessionToken = randomBytes(32).toString("base64url"); const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await client.query("INSERT INTO approval_sessions(token_hash,intent_lock_id,buyer_id,expires_at) VALUES($1,$2,$3,$4)", [sha256(sessionToken), purchasePermitId, buyerId, expiresAt]);
      await this.appendAudit({ scopeType: "intent", scopeId: purchasePermitId, merchantId: result.rows[0].merchant_id, purchasePermitId, eventType: "APPROVAL_LINK_EXCHANGED", actor: "buyer", reasonCode: null, payload: { expiresAt, tokenRemovedFromUrl: true } }, client);
      return { token: sessionToken, expiresAt };
    });
  }

  async getApprovalSession(purchasePermitId: string, buyerId: string, token: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM approval_sessions WHERE intent_lock_id=$1 AND buyer_id=$2 AND token_hash=$3 AND used_at IS NULL AND expires_at>now()", [purchasePermitId, buyerId, sha256(token)]);
    return Boolean(result.rowCount);
  }

  async completeApproval(input: { purchasePermitId: string; buyerId: string; sessionToken: string; credentialId: string; counter: number; deviceType: string; backedUp: boolean }): Promise<PurchasePermit | null> {
    return transaction(this.pool, async (client) => {
      const consumed = await client.query("UPDATE approval_sessions SET used_at=now() WHERE intent_lock_id=$1 AND buyer_id=$2 AND token_hash=$3 AND used_at IS NULL AND expires_at>now() RETURNING 1", [input.purchasePermitId, input.buyerId, sha256(input.sessionToken)]);
      if (!consumed.rowCount) return null;
      const result = await client.query("UPDATE intent_locks SET confirmed_at=now(),status='confirmed' WHERE id=$1 AND buyer_id=$2 AND status='pending_confirmation' RETURNING *", [input.purchasePermitId, input.buyerId]);
      if (!result.rows[0]) return null;
      await client.query("UPDATE passkey_credentials SET counter=$2 WHERE credential_id=$1", [input.credentialId, input.counter]);
      await this.appendAudit({ scopeType: "intent", scopeId: input.purchasePermitId, merchantId: result.rows[0].merchant_id, purchasePermitId: input.purchasePermitId, eventType: "PASSKEY_VERIFIED", actor: "buyer", reasonCode: null, payload: { credentialIdHash: sha256(input.credentialId), deviceType: input.deviceType, backedUp: input.backedUp, userVerified: true } }, client);
      await this.appendAudit({ scopeType: "intent", scopeId: input.purchasePermitId, merchantId: result.rows[0].merchant_id, purchasePermitId: input.purchasePermitId, eventType: "HUMAN_CONFIRMATION_RECORDED", actor: "buyer", reasonCode: null, payload: { method: "passkey", buyerId: input.buyerId } }, client);
      if (result.rows[0].deal_session_id) await this.appendAudit({ scopeType: "deal", scopeId: result.rows[0].deal_session_id, merchantId: result.rows[0].merchant_id, purchasePermitId: input.purchasePermitId, eventType: "PASSKEY_APPROVAL_RECORDED", actor: "buyer", reasonCode: null, payload: { method: "passkey", buyerId: input.buyerId, purchasePermitId: input.purchasePermitId } }, client);
      await this.recordAiCommerceEvent({ merchantId: result.rows[0].merchant_id, productId: result.rows[0].product_id, purchasePermitId: input.purchasePermitId, eventType: "PASSKEY_APPROVED", source: "buyer_web", deduplicationKey: `approval:${input.purchasePermitId}` }, client);
      return mapIntent(result.rows[0]);
    });
  }

  async prepareOrderClaim(purchasePermitId: string, buyerId: string, evaluate: (intent: PurchasePermit, product: Product | null) => { allowed: boolean; reasons: ReasonCode[]; message: string; evaluatedAt: string; observedAt: string; observedPricePaise: number; observedProductVersion: number | null; observedProductRevisionId: string | null; observedProductSnapshotHash: string | null; catalogAuthority: Product["catalogAuthority"] | null }, paymentConfigVersion: number): Promise<{ kind: "denied"; intent: PurchasePermit; decision: ReturnType<typeof evaluate> } | { kind: "existing"; intent: PurchasePermit; order: PaymentOrder } | { kind: "claimed"; intent: PurchasePermit; product: Product; order: PaymentOrder; decision: ReturnType<typeof evaluate> }> {
    return transaction(this.pool, async (client) => {
      const intent = await this.getIntent(purchasePermitId, buyerId, client, true);
      if (!intent) throw new Error("INTENT_NOT_FOUND");
      const existing = await this.getOrderByIntent(intent.id, client);
      if (existing) return { kind: "existing" as const, intent, order: existing };
      const product = await this.getProduct(intent.merchantId, intent.productId, client);
      const decision = evaluate(intent, product);
      await this.appendAudit({ scopeType: "intent", scopeId: intent.id, merchantId: intent.merchantId, purchasePermitId: intent.id, eventType: decision.allowed ? "POLICY_ALLOWED" : "POLICY_DENIED", actor: "policy_engine", reasonCode: decision.allowed ? "ALLOWED" : decision.reasons[0]!, payload: { decision, authoritativeProduct: product, source: "merchant_managed_catalog" } }, client);
      await this.recordAiCommerceEvent({ merchantId: intent.merchantId, productId: intent.productId, purchasePermitId: intent.id, eventType: decision.allowed ? "POLICY_ALLOWED" : "POLICY_DENIED", source: "policy_engine", deduplicationKey: `policy:${decision.allowed ? "allowed" : "denied"}:${intent.id}` }, client);
      if (!decision.allowed || !product) {
        const status = decision.reasons.includes("EXPIRED") ? "expired" : "denied";
        const updated = await client.query("UPDATE intent_locks SET status=$2 WHERE id=$1 RETURNING *", [intent.id, status]);
        return { kind: "denied" as const, intent: mapIntent(updated.rows[0]), decision };
      }
      const checkoutToken = randomBytes(32).toString("base64url"); const orderId = randomUUID(); const createdAt = new Date().toISOString();
      const storedCatalogSource = product.catalogAuthority.source === "shopify_admin_graphql" ? "shopify_admin_graphql" : "agentrail_server";
      await client.query(`INSERT INTO payment_orders(id,intent_lock_id,merchant_id,buyer_id,amount_paise,checkout_token_hash,checkout_token,status,observed_product_version,observed_product_revision_id,observed_snapshot_hash,observed_catalog_source,observed_shop_domain,observed_at,payment_config_version,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'creating',$8,$9,$10,$11,$12,$13,$14,$15)`, [orderId, intent.id, intent.merchantId, intent.buyerId, product.pricePaise, sha256(checkoutToken), checkoutToken, product.version, product.revisionId, product.snapshotHash, storedCatalogSource, product.catalogAuthority.shopDomain ?? null, decision.observedAt, paymentConfigVersion, createdAt]);
      await client.query("UPDATE intent_locks SET status='executing' WHERE id=$1", [intent.id]);
      return { kind: "claimed" as const, intent: { ...intent, status: "executing" }, product, order: (await this.getOrder(orderId, client))!, decision };
    });
  }

  async completeOrder(orderId: string, providerOrderId: string, adapter: "mock" | "razorpay"): Promise<PaymentOrder> {
    return transaction(this.pool, async (client) => {
      const result = await client.query("UPDATE payment_orders SET provider_order_id=$2,status='ready' WHERE id=$1 RETURNING *", [orderId, providerOrderId]);
      const order = mapOrder(result.rows[0]);
      await client.query("UPDATE intent_locks SET status='checkout_ready' WHERE id=$1", [order.purchasePermitId]);
      await this.appendAudit({ scopeType: "intent", scopeId: order.purchasePermitId, merchantId: order.merchantId, purchasePermitId: order.purchasePermitId, eventType: "PAYMENT_ORDER_CREATED", actor: adapter === "mock" ? "mock_adapter" : "razorpay", reasonCode: null, payload: { adapter, orderId, providerOrderId, amountPaise: order.amountPaise, observedProductVersion: order.observedProductVersion, observedProductRevisionId: order.observedProductRevisionId, observedSnapshotHash: order.observedProductSnapshotHash, paymentConfigVersion: order.paymentConfigVersion } }, client);
      const linked = await client.query("SELECT deal_session_id,public_unit_price_paise,negotiated_unit_price_paise FROM intent_locks WHERE id=$1", [order.purchasePermitId]);
      if (linked.rows[0]?.deal_session_id) await this.appendAudit({ scopeType: "deal", scopeId: linked.rows[0].deal_session_id, merchantId: order.merchantId, purchasePermitId: order.purchasePermitId, eventType: adapter === "razorpay" ? "RAZORPAY_TEST_ORDER_CREATED" : "MOCK_ORDER_CREATED", actor: adapter === "mock" ? "mock_adapter" : "razorpay", reasonCode: null, payload: { adapter, orderId, providerOrderId, amountPaise: order.amountPaise, publicUnitPricePaise: linked.rows[0].public_unit_price_paise, negotiatedUnitPricePaise: linked.rows[0].negotiated_unit_price_paise, paymentConfigVersion: order.paymentConfigVersion } }, client);
      await this.recordAiCommerceEvent({ merchantId: order.merchantId, purchasePermitId: order.purchasePermitId, paymentOrderId: order.id, eventType: "PAYMENT_ORDER_CREATED", source: adapter === "mock" ? "mock_adapter" : "razorpay", deduplicationKey: `order:${order.id}` }, client);
      return order;
    });
  }

  async markReconciliation(orderId: string, message: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      const result = await client.query("UPDATE payment_orders SET status='reconciliation_required' WHERE id=$1 RETURNING *", [orderId]); if (!result.rows[0]) return;
      await client.query("UPDATE intent_locks SET status='reconciliation_required' WHERE id=$1", [result.rows[0].intent_lock_id]);
      await this.appendAudit({ scopeType: "intent", scopeId: result.rows[0].intent_lock_id, merchantId: result.rows[0].merchant_id, purchasePermitId: result.rows[0].intent_lock_id, eventType: "PAYMENT_RECONCILIATION_REQUIRED", actor: "policy_engine", reasonCode: "PAYMENT_PROVIDER_UNCERTAIN", payload: { message } }, client);
      const linked = await client.query("SELECT deal_session_id FROM intent_locks WHERE id=$1", [result.rows[0].intent_lock_id]);
      if (linked.rows[0]?.deal_session_id) {
        await client.query("UPDATE deal_sessions SET status='reconciliation_required',updated_at=now() WHERE id=$1", [linked.rows[0].deal_session_id]);
        await this.appendAudit({ scopeType: "deal", scopeId: linked.rows[0].deal_session_id, merchantId: result.rows[0].merchant_id, purchasePermitId: result.rows[0].intent_lock_id, eventType: "PAYMENT_RECONCILIATION_REQUIRED", actor: "policy_engine", reasonCode: "PAYMENT_PROVIDER_UNCERTAIN", payload: { automaticRetry: false } }, client);
      }
    });
  }

  async markPaid(orderId: string, paymentId: string, adapter: "mock" | "razorpay"): Promise<PaymentOrder> {
    return transaction(this.pool, async (client) => {
      const result = await client.query("UPDATE payment_orders SET status='paid',payment_id=COALESCE(payment_id,$2) WHERE id=$1 RETURNING *", [orderId, paymentId]);
      const order = mapOrder(result.rows[0]); await client.query("UPDATE intent_locks SET status='paid' WHERE id=$1", [order.purchasePermitId]);
      await this.appendAudit({ scopeType: "intent", scopeId: order.purchasePermitId, merchantId: order.merchantId, purchasePermitId: order.purchasePermitId, eventType: "PAYMENT_VERIFIED", actor: adapter === "mock" ? "mock_adapter" : "razorpay", reasonCode: null, payload: { adapter, providerOrderId: order.providerOrderId, paymentId } }, client);
      await this.recordAiCommerceEvent({ merchantId: order.merchantId, purchasePermitId: order.purchasePermitId, paymentOrderId: order.id, eventType: "PAYMENT_VERIFIED", source: adapter === "mock" ? "mock_adapter" : "razorpay", deduplicationKey: `payment:${order.id}` }, client);
      const linked = await client.query("SELECT deal_session_id,public_unit_price_paise,negotiated_unit_price_paise FROM intent_locks WHERE id=$1", [order.purchasePermitId]);
      if (linked.rows[0]?.deal_session_id) {
        if (adapter === "razorpay") await client.query("UPDATE deal_sessions SET status='paid',updated_at=now() WHERE id=$1", [linked.rows[0].deal_session_id]);
        await this.appendAudit({ scopeType: "deal", scopeId: linked.rows[0].deal_session_id, merchantId: order.merchantId, purchasePermitId: order.purchasePermitId, eventType: adapter === "razorpay" ? "RAZORPAY_TEST_PAYMENT_VERIFIED" : "MOCK_PAYMENT_COMPLETED", actor: adapter === "mock" ? "mock_adapter" : "razorpay", reasonCode: null, payload: { adapter, providerOrderId: order.providerOrderId, paymentId, amountPaise: order.amountPaise, providerVerified: adapter === "razorpay" } }, client);
      }
      return order;
    });
  }

  async getOrder(id: string, db: Queryable = this.pool): Promise<PaymentOrder | null> { const result = await db.query("SELECT * FROM payment_orders WHERE id=$1", [id]); return result.rows[0] ? mapOrder(result.rows[0]) : null; }
  async getOrderByIntent(intentId: string, db: Queryable = this.pool): Promise<PaymentOrder | null> { const result = await db.query("SELECT * FROM payment_orders WHERE intent_lock_id=$1", [intentId]); return result.rows[0] ? mapOrder(result.rows[0]) : null; }
  async getOrderByProvider(merchantId: string, providerOrderId: string): Promise<PaymentOrder | null> { const result = await this.pool.query("SELECT * FROM payment_orders WHERE merchant_id=$1 AND provider_order_id=$2", [merchantId, providerOrderId]); return result.rows[0] ? mapOrder(result.rows[0]) : null; }
  async getOrderByCheckoutToken(token: string): Promise<PaymentOrder | null> { const result = await this.pool.query("SELECT * FROM payment_orders WHERE checkout_token_hash=$1", [sha256(token)]); return result.rows[0] ? mapOrder(result.rows[0]) : null; }
  async listMerchantOrders(merchantId: string): Promise<PaymentOrder[]> { const result = await this.pool.query("SELECT * FROM payment_orders WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 100", [merchantId]); return result.rows.map(mapOrder); }

  async savePaymentConfig(merchantId: string, config: Omit<PaymentConfiguration, "merchantId" | "version">): Promise<PaymentConfiguration> {
    const result = await this.pool.query(`WITH next AS (SELECT COALESCE(MAX(version),0)+1 AS version FROM merchant_payment_configurations WHERE merchant_id=$1), disabled AS (UPDATE merchant_payment_configurations SET active=false WHERE merchant_id=$1)
      INSERT INTO merchant_payment_configurations(id,merchant_id,adapter,key_id,key_secret_ciphertext,webhook_secret_ciphertext,encryption_key_version,version)
      SELECT $2,$1,$3,$4,$5,$6,$7,version FROM next RETURNING *`, [merchantId, randomUUID(), config.adapter, config.keyId, config.keySecretCiphertext, config.webhookSecretCiphertext, config.encryptionKeyVersion]);
    return mapPaymentConfig(result.rows[0]);
  }

  async paymentConfig(merchantId: string, version?: number): Promise<PaymentConfiguration | null> { const result = version === undefined
    ? await this.pool.query("SELECT * FROM merchant_payment_configurations WHERE merchant_id=$1 AND active=true ORDER BY version DESC LIMIT 1", [merchantId])
    : await this.pool.query("SELECT * FROM merchant_payment_configurations WHERE merchant_id=$1 AND version=$2", [merchantId, version]);
    return result.rows[0] ? mapPaymentConfig(result.rows[0]) : null; }

  async recordWebhook(merchantId: string, eventId: string, eventType: string): Promise<boolean> { const result = await this.pool.query("INSERT INTO webhook_events(merchant_id,event_id,event_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [merchantId, eventId, eventType]); return Boolean(result.rowCount); }

  async createApiKey(merchantId: string, name: string, scopes: string[], expiresAt: string | null): Promise<{ id: string; key: string; prefix: string }> {
    return transaction(this.pool, async (client) => {
      const created = await this.insertApiKey(client, merchantId, name, scopes, expiresAt);
      await this.appendAudit({ scopeType: "merchant", scopeId: merchantId, merchantId, purchasePermitId: null, eventType: "API_KEY_CREATED", actor: "merchant", reasonCode: null, payload: { apiKeyId: created.id, prefix: created.prefix, name, scopes, expiresAt } }, client);
      return created;
    });
  }

  async rotateApiKey(merchantId: string, id: string): Promise<{ id: string; key: string; prefix: string } | null> {
    return transaction(this.pool, async (client) => {
      const previous = await client.query("UPDATE merchant_api_keys SET revoked_at=now() WHERE merchant_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING name,scopes_json,expires_at", [merchantId, id]); if (!previous.rows[0]) return null;
      const created = await this.insertApiKey(client, merchantId, previous.rows[0].name, previous.rows[0].scopes_json, previous.rows[0].expires_at ? iso(previous.rows[0].expires_at) : null);
      await this.appendAudit({ scopeType: "merchant", scopeId: merchantId, merchantId, purchasePermitId: null, eventType: "API_KEY_ROTATED", actor: "merchant", reasonCode: null, payload: { previousApiKeyId: id, replacementApiKeyId: created.id, prefix: created.prefix, scopes: previous.rows[0].scopes_json } }, client);
      return created;
    });
  }

  async authenticateApiKey(key: string): Promise<{ merchantId: string; scopes: string[] } | null> {
    const result = await this.pool.query(`UPDATE merchant_api_keys SET last_used_at=now() WHERE secret_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) RETURNING merchant_id,scopes_json`, [sha256(key)]);
    return result.rows[0] ? { merchantId: result.rows[0].merchant_id, scopes: result.rows[0].scopes_json } : null;
  }

  async revokeApiKey(merchantId: string, id: string): Promise<boolean> { return transaction(this.pool, async (client) => { const result = await client.query("UPDATE merchant_api_keys SET revoked_at=now() WHERE merchant_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING prefix", [merchantId, id]); if (!result.rowCount) return false; await this.appendAudit({ scopeType: "merchant", scopeId: merchantId, merchantId, purchasePermitId: null, eventType: "API_KEY_REVOKED", actor: "merchant", reasonCode: null, payload: { apiKeyId: id, prefix: result.rows[0].prefix } }, client); return true; }); }
  async listApiKeys(merchantId: string): Promise<unknown[]> { return (await this.pool.query("SELECT id,name,prefix,scopes_json AS scopes,expires_at AS \"expiresAt\",last_used_at AS \"lastUsedAt\",revoked_at AS \"revokedAt\",created_at AS \"createdAt\" FROM merchant_api_keys WHERE merchant_id=$1 ORDER BY created_at DESC", [merchantId])).rows; }

  private async insertApiKey(client: Queryable, merchantId: string, name: string, scopes: string[], expiresAt: string | null) {
    const secret = randomBytes(32).toString("base64url"); const key = `ss_test_${secret}`; const prefix = key.slice(0, 16); const id = randomUUID();
    await client.query("INSERT INTO merchant_api_keys(id,merchant_id,name,prefix,secret_hash,scopes_json,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, merchantId, name, prefix, sha256(key), JSON.stringify(scopes), expiresAt]); return { id, key, prefix };
  }

  async appendAudit(input: { scopeType: "intent" | "merchant" | "deal"; scopeId: string; merchantId: string; purchasePermitId: string | null; eventType: string; actor: AuditActor; reasonCode: ReasonCode | null; payload: unknown }, db?: PoolClient): Promise<AuditEvent> {
    if (!db) return transaction(this.pool, (client) => this.appendAudit(input, client));
    await db.query("INSERT INTO audit_chain_heads(scope_type,scope_id,merchant_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [input.scopeType, input.scopeId, input.merchantId]);
    const head = (await db.query("SELECT * FROM audit_chain_heads WHERE scope_type=$1 AND scope_id=$2 FOR UPDATE", [input.scopeType, input.scopeId])).rows[0];
    const event = { id: randomUUID(), sequence: head.sequence + 1, scopeType: input.scopeType, scopeId: input.scopeId, merchantId: input.merchantId, purchasePermitId: input.purchasePermitId, eventType: input.eventType, actor: input.actor, reasonCode: input.reasonCode, payload: input.payload, previousHash: head.hash, createdAt: new Date().toISOString() };
    const hash = hashAuditPayload(head.hash, auditHashEvent(event));
    await db.query(`INSERT INTO audit_events(id,sequence,scope_type,scope_id,merchant_id,intent_lock_id,event_type,actor,reason_code,payload_json,previous_hash,hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [event.id, event.sequence, event.scopeType, event.scopeId, event.merchantId, event.purchasePermitId, event.eventType, event.actor, event.reasonCode, event.payload, event.previousHash, hash, event.createdAt]);
    await db.query("UPDATE audit_chain_heads SET sequence=$3,hash=$4 WHERE scope_type=$1 AND scope_id=$2", [event.scopeType, event.scopeId, event.sequence, hash]);
    return { ...event, hash };
  }

  async auditTrail(scopeType: "intent" | "merchant" | "deal", scopeId: string): Promise<AuditEvent[]> { const result = await this.pool.query("SELECT * FROM audit_events WHERE scope_type=$1 AND scope_id=$2 ORDER BY sequence", [scopeType, scopeId]); return result.rows.map(mapAudit); }

  async verifyAudit(scopeType: "intent" | "merchant" | "deal", scopeId: string): Promise<{ valid: boolean; checked: number; brokenAt: number | null }> {
    const events = await this.auditTrail(scopeType, scopeId); let previous = "GENESIS";
    for (const event of events) { const { hash, ...withoutHash } = event; if (event.previousHash !== previous || hashAuditPayload(previous, auditHashEvent(withoutHash)) !== hash) return { valid: false, checked: event.sequence, brokenAt: event.sequence }; previous = hash; }
    return { valid: true, checked: events.length, brokenAt: null };
  }

  async rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const result = await this.pool.query(`INSERT INTO rate_limits(key,count,window_ends_at) VALUES($1,1,now()+($2||' seconds')::interval)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.window_ends_at<=now() THEN 1 ELSE rate_limits.count+1 END,window_ends_at=CASE WHEN rate_limits.window_ends_at<=now() THEN now()+($2||' seconds')::interval ELSE rate_limits.window_ends_at END,updated_at=now() RETURNING count`, [key, windowSeconds]);
    return result.rows[0].count <= limit;
  }
}

function productSnapshot(input: { id: string; merchantId: string; sku: string; name: string; description: string; pricePaise: number; refundable: boolean; refundWindowDays: number; active: boolean; version: number; revisionId: string; catalogSource: "agentrail_server" | "shopify_admin_graphql"; shopDomain: string | null; externalId: string | null; externalUpdatedAt: string | null }) {
  const source = input.catalogSource === "shopify_admin_graphql" ? "shopify_admin_graphql" : "spendseal_server";
  return { ...input, catalogSource: source, currency: "INR", refundTermsAuthority: "merchant_stated", catalogAuthority: { type: "merchant_managed_catalog", merchantId: input.merchantId, source, shopDomain: input.shopDomain } };
}

function mapUser(row: any): User { return { id: row.id, username: row.username, displayName: row.display_name, status: row.status, createdAt: iso(row.created_at) }; }
function mapMerchant(row: any): Merchant { return { id: row.id, slug: row.slug, displayName: row.display_name, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }
function mapPasskey(row: any): StoredPasskey { return { id: row.credential_id, userId: row.user_id, rpId: row.rp_id, publicKey: new Uint8Array(Buffer.from(row.public_key_b64, "base64")), counter: row.counter, deviceType: row.device_type, backedUp: row.backed_up, transports: row.transports_json }; }
function mapProduct(row: any): Product { return { id: row.id, merchantId: row.merchant_id, sku: row.sku, name: row.name, description: row.description, pricePaise: row.price_paise, currency: "INR", refundable: row.refundable, refundWindowDays: row.refund_window_days, active: row.active, version: row.version, revisionId: row.current_revision_id, snapshotHash: row.snapshot_hash, catalogAuthority: { type: "merchant_managed_catalog", merchantId: row.merchant_id, source: row.catalog_source === "shopify_admin_graphql" ? "shopify_admin_graphql" : "spendseal_server", shopDomain: row.catalog_source === "shopify_admin_graphql" ? row.shop_domain ?? null : null }, refundTermsAuthority: "merchant_stated", createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }
function mapIntent(row: any): PurchasePermit { return { id: row.id, buyerId: row.buyer_id, merchantId: row.merchant_id, productId: row.product_id, productRevisionId: row.product_revision_id, quantity: 1, currency: "INR", productSnapshotHash: row.product_snapshot_hash, lockedUnitPricePaise: row.locked_unit_price_paise, maxTotalPaise: row.max_total_paise, priceChangePolicy: row.price_change_policy, requireRefundable: row.require_refundable, minimumRefundWindowDays: row.minimum_refund_window_days, expiresAt: iso(row.expires_at), confirmationRequired: true, confirmedAt: row.confirmed_at ? iso(row.confirmed_at) : null, idempotencyKey: row.idempotency_key, status: row.status, createdAt: iso(row.created_at), negotiatedDeal: row.deal_session_id ? { dealSessionId: row.deal_session_id, dealPolicyId: row.deal_policy_id, dealPolicyVersion: row.deal_policy_version, publicUnitPricePaise: row.public_unit_price_paise, negotiatedUnitPricePaise: row.negotiated_unit_price_paise, buyerMaxTotalPaise: row.max_total_paise, acceptedOfferSnapshotHash: row.accepted_offer_snapshot_hash, dealExpiresAt: iso(row.deal_expires_at), savingsPaise: row.public_unit_price_paise - row.negotiated_unit_price_paise } : null }; }
function mapOrder(row: any): PaymentOrder { return { id: row.id, purchasePermitId: row.intent_lock_id, merchantId: row.merchant_id, buyerId: row.buyer_id, providerOrderId: row.provider_order_id ?? "pending", amountPaise: row.amount_paise, currency: "INR", checkoutToken: row.checkout_token, status: row.status, paymentId: row.payment_id, createdAt: iso(row.created_at), observedProductVersion: row.observed_product_version, observedProductRevisionId: row.observed_product_revision_id, observedProductSnapshotHash: row.observed_snapshot_hash, catalogAuthority: { type: "merchant_managed_catalog", merchantId: row.merchant_id, source: row.observed_catalog_source === "shopify_admin_graphql" ? "shopify_admin_graphql" : "spendseal_server", shopDomain: row.observed_shop_domain ?? null }, observedAt: iso(row.observed_at), paymentConfigVersion: row.payment_config_version }; }
function mapCatalogConnection(row: any): CatalogConnection { return { merchantId: row.merchant_id, provider: row.provider, shopDomain: row.shop_domain, accessTokenCiphertext: row.access_token_ciphertext, encryptionKeyVersion: row.encryption_key_version, status: row.status, shopName: row.shop_name, currency: row.currency, defaultRefundable: row.default_refundable, defaultRefundWindowDays: row.default_refund_window_days, lastSyncAt: row.last_sync_at ? iso(row.last_sync_at) : null }; }
function mapPaymentConfig(row: any): PaymentConfiguration { return { merchantId: row.merchant_id, adapter: row.adapter, keyId: row.key_id, keySecretCiphertext: row.key_secret_ciphertext, webhookSecretCiphertext: row.webhook_secret_ciphertext, encryptionKeyVersion: row.encryption_key_version, version: row.version }; }
function mapAudit(row: any): AuditEvent { return { id: row.id, sequence: row.sequence, scopeType: row.scope_type, scopeId: row.scope_id, merchantId: row.merchant_id, purchasePermitId: row.intent_lock_id, eventType: row.event_type, actor: row.actor, reasonCode: row.reason_code, payload: row.payload_json, previousHash: row.previous_hash, hash: row.hash, createdAt: iso(row.created_at) }; }
function auditHashEvent<T extends { purchasePermitId: string | null }>(event: T): Omit<T, "purchasePermitId"> & { intentLockId: string | null } { const { purchasePermitId, ...rest } = event; return { ...rest, intentLockId: purchasePermitId }; }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
