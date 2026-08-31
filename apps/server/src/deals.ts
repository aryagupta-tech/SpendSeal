import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  evaluateNegotiationOffer,
  sha256,
  type DealPolicy,
  type PaymentOrder,
  type PolicyDecision,
  type PriceNegotiation,
  type Product,
  type PurchasePermit,
  type ReasonCode,
} from "@spendseal/core";
import { CredentialVault } from "./credentials.js";
import { transaction } from "./db/client.js";
import { SpendSealStore } from "./store.js";

type Queryable = { query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> };
type Claimed = { kind: "claimed"; intent: PurchasePermit; product: Product; order: PaymentOrder; decision: PolicyDecision };
type Existing = { kind: "existing"; intent: PurchasePermit; order: PaymentOrder };
type Denied = { kind: "denied"; intent: PurchasePermit; decision: PolicyDecision };

export class DealError extends Error {
  constructor(readonly status: number, readonly code: ReasonCode | "DEAL_NOT_FOUND" | "NEGOTIATION_NOT_AVAILABLE" | "INVALID_DEAL_POLICY", message: string) { super(message); }
}

export class PriceNegotiationService {
  constructor(readonly store: SpendSealStore, readonly vault: CredentialVault) {}

  async listPolicies(merchantId: string): Promise<DealPolicy[]> {
    const result = await this.store.pool.query(`SELECT DISTINCT ON (dp.product_id) dp.*,p.name AS product_name,p.price_paise AS public_price_paise
      FROM merchant_deal_policies dp JOIN products p ON p.id=dp.product_id AND p.merchant_id=dp.merchant_id
      WHERE dp.merchant_id=$1 ORDER BY dp.product_id,dp.version DESC`, [merchantId]);
    return result.rows.map((row) => this.mapPolicy(row, true));
  }

  async savePolicy(input: { merchantId: string; productId: string; minimumPricePaise: number; actorUserId: string }): Promise<DealPolicy> {
    return transaction(this.store.pool, async (client) => {
      const productResult = await client.query("SELECT * FROM products WHERE merchant_id=$1 AND id=$2 AND active=true FOR UPDATE", [input.merchantId, input.productId]);
      const product = productResult.rows[0];
      if (!product) throw new DealError(404, "NEGOTIATION_NOT_AVAILABLE", "The active merchant product was not found.");
      if (!Number.isInteger(input.minimumPricePaise) || input.minimumPricePaise <= 0 || input.minimumPricePaise >= product.price_paise) throw new DealError(400, "INVALID_DEAL_POLICY", "The private minimum must be positive and lower than the current public price.");
      const latest = await client.query("SELECT COALESCE(MAX(version),0)::int AS version FROM merchant_deal_policies WHERE merchant_id=$1 AND product_id=$2", [input.merchantId, input.productId]);
      const version = Number(latest.rows[0].version) + 1; const id = randomUUID(); const createdAt = new Date().toISOString();
      await client.query(`INSERT INTO merchant_deal_policies(id,merchant_id,product_id,version,floor_price_ciphertext,encryption_key_version,active,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,true,$7,$8)`, [id, input.merchantId, input.productId, version, this.vault.encrypt(String(input.minimumPricePaise)), this.vault.version, input.actorUserId, createdAt]);
      await this.invalidateOpenDeals(client, input.merchantId, input.productId, id);
      await this.store.appendAudit({ scopeType: "merchant", scopeId: input.merchantId, merchantId: input.merchantId, purchasePermitId: null, eventType: "DEAL_POLICY_VERSION_CREATED", actor: "merchant", reasonCode: null, payload: { policyId: id, productId: input.productId, productName: product.name, version, active: true, privateMinimumStoredEncrypted: true } }, client);
      return { id, merchantId: input.merchantId, productId: input.productId, version, active: true, minimumPricePaise: input.minimumPricePaise, createdBy: input.actorUserId, createdAt };
    });
  }

  async disablePolicy(input: { merchantId: string; productId: string; actorUserId: string }): Promise<DealPolicy> {
    return transaction(this.store.pool, async (client) => {
      const latest = await client.query("SELECT * FROM merchant_deal_policies WHERE merchant_id=$1 AND product_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE", [input.merchantId, input.productId]);
      const current = latest.rows[0]; if (!current) throw new DealError(404, "NEGOTIATION_NOT_AVAILABLE", "No negotiation policy exists for this product.");
      const id = randomUUID(); const version = Number(current.version) + 1; const createdAt = new Date().toISOString();
      await client.query(`INSERT INTO merchant_deal_policies(id,merchant_id,product_id,version,floor_price_ciphertext,encryption_key_version,active,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,false,$7,$8)`, [id, input.merchantId, input.productId, version, current.floor_price_ciphertext, current.encryption_key_version, input.actorUserId, createdAt]);
      await this.invalidateOpenDeals(client, input.merchantId, input.productId, id);
      await this.store.appendAudit({ scopeType: "merchant", scopeId: input.merchantId, merchantId: input.merchantId, purchasePermitId: null, eventType: "DEAL_POLICY_DISABLED", actor: "merchant", reasonCode: null, payload: { policyId: id, productId: input.productId, version, active: false } }, client);
      return { id, merchantId: input.merchantId, productId: input.productId, version, active: false, minimumPricePaise: null, createdBy: input.actorUserId, createdAt };
    });
  }

  async start(input: { buyerId: string; productId: string; buyerMaxTotalPaise: number; initialOfferPaise: number; idempotencyKey?: string }): Promise<PriceNegotiation> {
    return transaction(this.store.pool, async (client) => {
      const key = input.idempotencyKey ?? `start:${input.productId}:${input.buyerMaxTotalPaise}:${input.initialOfferPaise}:${Math.floor(Date.now() / 600_000)}`;
      const replay = await client.query("SELECT id FROM deal_sessions WHERE buyer_id=$1 AND idempotency_key=$2", [input.buyerId, key]);
      if (replay.rows[0]) return this.get(input.buyerId, replay.rows[0].id, client);
      const expired = await client.query("UPDATE deal_sessions SET status='expired',updated_at=now() WHERE buyer_id=$1 AND product_id=$2 AND status IN ('negotiating','accepted','permit_created') AND expires_at<=now() RETURNING id,merchant_id", [input.buyerId, input.productId]);
      for (const row of expired.rows) await this.store.appendAudit({ scopeType: "deal", scopeId: row.id, merchantId: row.merchant_id, purchasePermitId: null, eventType: "DEAL_EXPIRED", actor: "policy_engine", reasonCode: "DEAL_EXPIRED", payload: { expired: true } }, client);
      const active = await client.query("SELECT 1 FROM deal_sessions WHERE buyer_id=$1 AND product_id=$2 AND status IN ('negotiating','accepted','permit_created')", [input.buyerId, input.productId]);
      if (active.rowCount) throw new DealError(409, "NEGOTIATION_LIMIT_REACHED", "An active deal already exists for this buyer and product.");
      const count = await client.query("SELECT COUNT(*)::int AS count FROM deal_sessions WHERE buyer_id=$1 AND product_id=$2 AND created_at>now()-interval '24 hours'", [input.buyerId, input.productId]);
      if (Number(count.rows[0].count) >= 3) throw new DealError(429, "NEGOTIATION_LIMIT_REACHED", "This buyer has reached the three-session limit for this product in 24 hours.");
      const productResult = await client.query(`SELECT p.*,pr.snapshot_hash FROM products p JOIN product_revisions pr ON pr.id=p.current_revision_id WHERE p.id=$1 AND p.active=true`, [input.productId]);
      const product = productResult.rows[0]; if (!product) throw new DealError(404, "NEGOTIATION_NOT_AVAILABLE", "This product is not available for negotiation.");
      const policyResult = await client.query("SELECT * FROM merchant_deal_policies WHERE merchant_id=$1 AND product_id=$2 ORDER BY version DESC LIMIT 1", [product.merchant_id, input.productId]);
      const policy = policyResult.rows[0]; if (!policy?.active) throw new DealError(409, "NEGOTIATION_NOT_AVAILABLE", "The merchant has not enabled negotiation for this product.");
      this.validateOffer(input.initialOfferPaise, input.buyerMaxTotalPaise);
      const id = randomUUID(); const now = new Date().toISOString(); const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      await client.query(`INSERT INTO deal_sessions(id,buyer_id,merchant_id,product_id,product_revision_id,product_snapshot_hash,product_name,public_price_paise,buyer_max_total_paise,policy_id,policy_version,status,idempotency_key,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'negotiating',$12,$13,$14,$14)`, [id, input.buyerId, product.merchant_id, input.productId, product.current_revision_id, product.snapshot_hash, product.name, product.price_paise, input.buyerMaxTotalPaise, policy.id, policy.version, key, expiresAt, now]);
      await this.store.appendAudit({ scopeType: "deal", scopeId: id, merchantId: product.merchant_id, purchasePermitId: null, eventType: "DEAL_STARTED", actor: "chatgpt", reasonCode: null, payload: { productId: input.productId, productName: product.name, productRevisionId: product.current_revision_id, productSnapshotHash: product.snapshot_hash, publicPricePaise: product.price_paise, buyerAuthorityBound: true, policyVersion: policy.version, maximumBuyerOffers: 3, expiresAt } }, client);
      await this.store.recordAiCommerceEvent({ merchantId: product.merchant_id, productId: input.productId, eventType: "NEGOTIATION_STARTED", source: "chatgpt_mcp", deduplicationKey: `negotiation:${id}` }, client);
      await this.submitOffer(client, id, input.buyerId, input.initialOfferPaise);
      return this.get(input.buyerId, id, client);
    });
  }

  async counter(input: { buyerId: string; dealSessionId: string; offerPaise: number }): Promise<PriceNegotiation> {
    return transaction(this.store.pool, async (client) => { await this.submitOffer(client, input.dealSessionId, input.buyerId, input.offerPaise); return this.get(input.buyerId, input.dealSessionId, client); });
  }

  async get(buyerId: string, dealSessionId: string, db: Queryable = this.store.pool): Promise<PriceNegotiation> {
    const result = await db.query("SELECT * FROM deal_sessions WHERE id=$1 AND buyer_id=$2", [dealSessionId, buyerId]);
    if (!result.rows[0]) throw new DealError(404, "DEAL_NOT_FOUND", "Price negotiation not found for this buyer.");
    const rounds = await db.query("SELECT * FROM deal_rounds WHERE deal_session_id=$1 ORDER BY sequence", [dealSessionId]);
    return mapDeal(result.rows[0], rounds.rows);
  }

  async createPermit(input: { buyerId: string; dealSessionId: string }): Promise<{ intent: PurchasePermit; approvalToken: string | null }> {
    return transaction(this.store.pool, async (client) => {
      const dealResult = await client.query("SELECT * FROM deal_sessions WHERE id=$1 AND buyer_id=$2 FOR UPDATE", [input.dealSessionId, input.buyerId]); const deal = dealResult.rows[0];
      if (!deal) throw new DealError(404, "DEAL_NOT_FOUND", "Price negotiation not found for this buyer.");
      if (deal.purchase_permit_id) return { intent: (await this.store.getIntent(deal.purchase_permit_id, input.buyerId, client))!, approvalToken: null };
      if (deal.status !== "accepted" || !deal.accepted_price_paise || !deal.accepted_offer_snapshot_hash) throw new DealError(409, "NO_DEAL", "A PurchasePermit can be created only after the merchant agent accepts a deal.");
      if (new Date(deal.expires_at).getTime() <= Date.now()) { await client.query("UPDATE deal_sessions SET status='expired',updated_at=now() WHERE id=$1", [deal.id]); throw new DealError(409, "DEAL_EXPIRED", "The accepted deal has expired."); }
      const { product, policy, floor } = await this.revalidationEvidence(client, deal);
      if (!policy?.active || policy.id !== deal.policy_id || policy.version !== deal.policy_version) throw new DealError(409, "DEAL_POLICY_CHANGED", "The merchant negotiation policy changed. Start a new deal.");
      if (!product.active || product.revisionId !== deal.product_revision_id || product.snapshotHash !== deal.product_snapshot_hash || product.pricePaise !== deal.public_price_paise) throw new DealError(409, "CATALOG_CHANGED", "The authoritative Shopify product changed. Start a new deal.");
      if (deal.accepted_price_paise < floor) throw new DealError(409, "OFFER_BELOW_MERCHANT_AUTHORITY", "The accepted offer is outside the merchant agent's authority.");
      if (deal.accepted_price_paise > deal.buyer_max_total_paise) throw new DealError(409, "OFFER_ABOVE_BUYER_LIMIT", "The accepted offer exceeds the buyer's hard maximum.");
      const id = randomUUID(); const approvalToken = randomBytes(32).toString("base64url"); const createdAt = new Date().toISOString();
      await client.query(`INSERT INTO intent_locks(id,buyer_id,merchant_id,product_id,product_revision_id,product_snapshot_hash,locked_unit_price_paise,max_total_paise,price_change_policy,require_refundable,minimum_refund_window_days,expires_at,idempotency_key,approval_token_hash,status,deal_session_id,deal_policy_id,deal_policy_version,public_unit_price_paise,negotiated_unit_price_paise,accepted_offer_snapshot_hash,deal_expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'none',$9,$10,$11,$12,$13,'pending_confirmation',$14,$15,$16,$17,$7,$18,$11,$19)`, [id, deal.buyer_id, deal.merchant_id, deal.product_id, deal.product_revision_id, deal.product_snapshot_hash, deal.accepted_price_paise, deal.buyer_max_total_paise, false, null, iso(deal.expires_at), `deal_intent_${deal.id}`, sha256(approvalToken), deal.id, deal.policy_id, deal.policy_version, deal.public_price_paise, deal.accepted_offer_snapshot_hash, createdAt]);
      await client.query("UPDATE deal_sessions SET status='permit_created',purchase_permit_id=$2,updated_at=now() WHERE id=$1", [deal.id, id]);
      const intent = (await this.store.getIntent(id, input.buyerId, client))!;
      const safeTerms = { dealSessionId: deal.id, productId: deal.product_id, productName: deal.product_name, publicUnitPricePaise: deal.public_price_paise, negotiatedUnitPricePaise: deal.accepted_price_paise, savingsPaise: deal.public_price_paise - deal.accepted_price_paise, buyerMaxTotalPaise: deal.buyer_max_total_paise, dealExpiresAt: iso(deal.expires_at), productRevisionId: deal.product_revision_id, productSnapshotHash: deal.product_snapshot_hash, acceptedOfferSnapshotHash: deal.accepted_offer_snapshot_hash, singleUse: true, paymentMode: "razorpay_test" };
      await this.store.appendAudit({ scopeType: "intent", scopeId: id, merchantId: deal.merchant_id, purchasePermitId: id, eventType: "NEGOTIATED_PURCHASE_PERMIT_CREATED", actor: "chatgpt", reasonCode: null, payload: { intent, negotiatedTerms: safeTerms, authorizedProduct: product } }, client);
      const { buyerMaxTotalPaise: _privateBuyerLimit, ...merchantSafeTerms } = safeTerms;
      await this.store.appendAudit({ scopeType: "deal", scopeId: deal.id, merchantId: deal.merchant_id, purchasePermitId: id, eventType: "PURCHASE_PERMIT_CREATED", actor: "chatgpt", reasonCode: null, payload: merchantSafeTerms }, client);
      await this.store.recordAiCommerceEvent({ merchantId: deal.merchant_id, productId: deal.product_id, purchasePermitId: id, eventType: "PURCHASE_PERMIT_CREATED", source: "chatgpt_mcp", deduplicationKey: `permit:${id}` }, client);
      return { intent, approvalToken };
    });
  }

  async prepareOrderClaim(purchasePermitId: string, buyerId: string, paymentConfigVersion: number): Promise<Claimed | Existing | Denied> {
    return transaction(this.store.pool, async (client) => {
      const intent = await this.store.getIntent(purchasePermitId, buyerId, client, true); if (!intent?.negotiatedDeal) throw new DealError(404, "DEAL_NOT_FOUND", "Negotiated PurchasePermit not found.");
      const existing = await this.store.getOrderByIntent(intent.id, client); if (existing) return { kind: "existing", intent, order: existing };
      const dealResult = await client.query("SELECT * FROM deal_sessions WHERE id=$1 FOR UPDATE", [intent.negotiatedDeal.dealSessionId]); const deal = dealResult.rows[0];
      const { product, policy, floor } = deal ? await this.revalidationEvidence(client, deal) : { product: null, policy: null, floor: 0 };
      const reasons: ReasonCode[] = [];
      if (["executing", "checkout_ready", "paid", "reconciliation_required"].includes(intent.status)) reasons.push("REPLAY_DETECTED");
      if (new Date(intent.expiresAt).getTime() <= Date.now() || !deal || new Date(deal.expires_at).getTime() <= Date.now()) reasons.push("DEAL_EXPIRED");
      if (!intent.confirmedAt) reasons.push("CONFIRMATION_REQUIRED");
      if (!product?.active) reasons.push("PRODUCT_INACTIVE");
      else if (product.id !== intent.productId || product.merchantId !== intent.merchantId || product.revisionId !== intent.productRevisionId || product.snapshotHash !== intent.productSnapshotHash || product.pricePaise !== intent.negotiatedDeal.publicUnitPricePaise) reasons.push("CATALOG_CHANGED");
      if (!policy?.active || policy.id !== intent.negotiatedDeal.dealPolicyId || policy.version !== intent.negotiatedDeal.dealPolicyVersion) reasons.push("DEAL_POLICY_CHANGED");
      if (intent.lockedUnitPricePaise > intent.maxTotalPaise) reasons.push("OFFER_ABOVE_BUYER_LIMIT");
      if (intent.lockedUnitPricePaise < floor) reasons.push("OFFER_BELOW_MERCHANT_AUTHORITY");
      if (product && intent.requireRefundable && !product.refundable) reasons.push("NOT_REFUNDABLE");
      if (product && intent.minimumRefundWindowDays !== null && product.refundWindowDays < intent.minimumRefundWindowDays) reasons.push("REFUND_POLICY_CHANGED");
      const unique = [...new Set(reasons)]; const now = new Date().toISOString();
      const decision: PolicyDecision = { allowed: unique.length === 0, reasons: unique.length ? unique : ["ALLOWED"], message: unique.length ? `Negotiated checkout blocked: ${unique.join(", ")}.` : "The negotiated deal, buyer ceiling, private merchant authority and Shopify evidence all passed.", evaluatedAt: now, observedAt: now, observedPricePaise: product?.pricePaise ?? 0, observedProductVersion: product?.version ?? null, observedProductRevisionId: product?.revisionId ?? null, observedProductSnapshotHash: product?.snapshotHash ?? null, catalogAuthority: product?.catalogAuthority ?? null };
      await this.store.appendAudit({ scopeType: "intent", scopeId: intent.id, merchantId: intent.merchantId, purchasePermitId: intent.id, eventType: decision.allowed ? "NEGOTIATED_POLICY_ALLOWED" : "POLICY_DENIED", actor: "policy_engine", reasonCode: decision.allowed ? "ALLOWED" : decision.reasons[0]!, payload: { decision, authoritativeProduct: product, negotiatedTerms: intent.negotiatedDeal } }, client);
      await this.store.appendAudit({ scopeType: "deal", scopeId: intent.negotiatedDeal.dealSessionId, merchantId: intent.merchantId, purchasePermitId: intent.id, eventType: decision.allowed ? "FINAL_POLICY_REVALIDATED" : "FINAL_POLICY_DENIED", actor: "policy_engine", reasonCode: decision.allowed ? "ALLOWED" : decision.reasons[0]!, payload: { decision: { ...decision, buyerAuthorityPassed: !decision.reasons.includes("OFFER_ABOVE_BUYER_LIMIT") }, publicUnitPricePaise: intent.negotiatedDeal.publicUnitPricePaise, negotiatedUnitPricePaise: intent.negotiatedDeal.negotiatedUnitPricePaise, policyVersion: intent.negotiatedDeal.dealPolicyVersion } }, client);
      await this.store.recordAiCommerceEvent({ merchantId: intent.merchantId, productId: intent.productId, purchasePermitId: intent.id, eventType: decision.allowed ? "POLICY_ALLOWED" : "POLICY_DENIED", source: "policy_engine", deduplicationKey: `policy:${decision.allowed ? "allowed" : "denied"}:${intent.id}` }, client);
      if (!decision.allowed || !product) { const status = decision.reasons.includes("DEAL_EXPIRED") ? "expired" : "denied"; const updated = await client.query("UPDATE intent_locks SET status=$2 WHERE id=$1 RETURNING *", [intent.id, status]); return { kind: "denied", intent: mapPermit(updated.rows[0]), decision }; }
      const checkoutToken = randomBytes(32).toString("base64url"); const orderId = randomUUID(); const source = product.catalogAuthority.source === "shopify_admin_graphql" ? "shopify_admin_graphql" : "agentrail_server";
      await client.query(`INSERT INTO payment_orders(id,intent_lock_id,merchant_id,buyer_id,amount_paise,checkout_token_hash,checkout_token,status,observed_product_version,observed_product_revision_id,observed_snapshot_hash,observed_catalog_source,observed_shop_domain,observed_at,payment_config_version,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'creating',$8,$9,$10,$11,$12,$13,$14,$13)`, [orderId, intent.id, intent.merchantId, intent.buyerId, intent.lockedUnitPricePaise, sha256(checkoutToken), checkoutToken, product.version, product.revisionId, product.snapshotHash, source, product.catalogAuthority.shopDomain ?? null, now, paymentConfigVersion]);
      await client.query("UPDATE intent_locks SET status='executing' WHERE id=$1", [intent.id]);
      return { kind: "claimed", intent: { ...intent, status: "executing" }, product, order: (await this.store.getOrder(orderId, client))!, decision };
    });
  }

  private async submitOffer(client: PoolClient, dealId: string, buyerId: string, offerPaise: number): Promise<void> {
    const result = await client.query("SELECT * FROM deal_sessions WHERE id=$1 AND buyer_id=$2 FOR UPDATE", [dealId, buyerId]); const deal = result.rows[0];
    if (!deal) throw new DealError(404, "DEAL_NOT_FOUND", "Price negotiation not found for this buyer.");
    const priorSame = await client.query("SELECT 1 FROM deal_rounds WHERE deal_session_id=$1 AND buyer_offer_paise=$2", [deal.id, offerPaise]); if (priorSame.rowCount) return;
    if (deal.status !== "negotiating") throw new DealError(409, deal.status === "rejected" ? "NO_DEAL" : deal.status === "invalidated" ? "DEAL_POLICY_CHANGED" : "NEGOTIATION_LIMIT_REACHED", "This deal session cannot accept another offer.");
    if (new Date(deal.expires_at).getTime() <= Date.now()) { await client.query("UPDATE deal_sessions SET status='expired',updated_at=now() WHERE id=$1", [deal.id]); throw new DealError(409, "DEAL_EXPIRED", "This deal session has expired."); }
    this.validateOffer(offerPaise, deal.buyer_max_total_paise);
    const previous = await client.query("SELECT buyer_offer_paise FROM deal_rounds WHERE deal_session_id=$1 ORDER BY sequence DESC LIMIT 1", [deal.id]);
    if (previous.rows[0] && offerPaise <= previous.rows[0].buyer_offer_paise) throw new DealError(400, "NEGOTIATION_LIMIT_REACHED", "Each buyer offer must be higher than the previous offer.");
    const round = Number(deal.round_count) + 1 as 1 | 2 | 3; if (round > 3) throw new DealError(409, "NEGOTIATION_LIMIT_REACHED", "This deal has reached the three-offer limit.");
    const policyResult = await client.query("SELECT * FROM merchant_deal_policies WHERE id=$1", [deal.policy_id]); const policy = policyResult.rows[0];
    const latest = await client.query("SELECT id,active FROM merchant_deal_policies WHERE merchant_id=$1 AND product_id=$2 ORDER BY version DESC LIMIT 1", [deal.merchant_id, deal.product_id]);
    if (!policy || !latest.rows[0]?.active || latest.rows[0].id !== policy.id) { await client.query("UPDATE deal_sessions SET status='invalidated',updated_at=now() WHERE id=$1", [deal.id]); throw new DealError(409, "DEAL_POLICY_CHANGED", "The merchant policy changed. Start a new negotiation."); }
    const floor = Number(this.vault.decrypt(policy.floor_price_ciphertext)); const outcome = evaluateNegotiationOffer({ publicPricePaise: deal.public_price_paise, minimumPricePaise: floor, round, offerPaise });
    const snapshotHash = sha256({ dealSessionId: deal.id, round, buyerOfferPaise: offerPaise, response: outcome.response, merchantCounterPaise: outcome.response === "counter" ? outcome.counterPaise : null }); const createdAt = new Date().toISOString();
    await client.query(`INSERT INTO deal_rounds(id,deal_session_id,sequence,buyer_offer_paise,response,merchant_counter_paise,reason_code,offer_snapshot_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), deal.id, round, offerPaise, outcome.response, outcome.response === "counter" ? outcome.counterPaise : null, outcome.response === "rejected" ? "NO_DEAL" : outcome.response === "accepted" ? "ALLOWED" : null, snapshotHash, createdAt]);
    const nextStatus = outcome.response === "accepted" ? "accepted" : outcome.response === "rejected" ? "rejected" : "negotiating";
    await client.query(`UPDATE deal_sessions SET status=$2,round_count=$3,merchant_last_counter_paise=$4,accepted_price_paise=$5,accepted_offer_snapshot_hash=$6,updated_at=$7 WHERE id=$1`, [deal.id, nextStatus, round, outcome.response === "counter" ? outcome.counterPaise : deal.merchant_last_counter_paise, outcome.response === "accepted" ? offerPaise : null, outcome.response === "accepted" ? snapshotHash : null, createdAt]);
    await this.store.appendAudit({ scopeType: "deal", scopeId: deal.id, merchantId: deal.merchant_id, purchasePermitId: null, eventType: "BUYER_OFFER_RECORDED", actor: "chatgpt", reasonCode: null, payload: { round, buyerOfferPaise: offerPaise, buyerAuthorityPassed: true, offerSnapshotHash: snapshotHash } }, client);
    const eventType = outcome.response === "counter" ? "MERCHANT_COUNTERED" : outcome.response === "accepted" ? "DEAL_ACCEPTED" : "DEAL_REJECTED";
    await this.store.appendAudit({ scopeType: "deal", scopeId: deal.id, merchantId: deal.merchant_id, purchasePermitId: null, eventType, actor: "merchant_agent", reasonCode: outcome.response === "accepted" ? "ALLOWED" : outcome.response === "rejected" ? "NO_DEAL" : null, payload: outcome.response === "counter" ? { round, merchantCounterPaise: outcome.counterPaise } : outcome.response === "accepted" ? { round, acceptedPricePaise: offerPaise, publicPricePaise: deal.public_price_paise, buyerAuthorityPassed: true, savingsPaise: deal.public_price_paise - offerPaise, acceptedOfferSnapshotHash: snapshotHash } : { round, result: "NO_DEAL", finalCounterWithheld: true } }, client);
    if (outcome.response !== "counter") await this.store.recordAiCommerceEvent({ merchantId: deal.merchant_id, productId: deal.product_id, eventType: outcome.response === "accepted" ? "DEAL_ACCEPTED" : "DEAL_REJECTED", source: "merchant_agent", deduplicationKey: `deal:${outcome.response}:${deal.id}` }, client);
  }

  private async revalidationEvidence(client: Queryable, deal: any): Promise<{ product: Product; policy: any; floor: number }> {
    const [product, policyResult] = await Promise.all([this.store.getProduct(deal.merchant_id, deal.product_id, client), client.query("SELECT * FROM merchant_deal_policies WHERE merchant_id=$1 AND product_id=$2 ORDER BY version DESC LIMIT 1", [deal.merchant_id, deal.product_id])]);
    const policy = policyResult.rows[0]; return { product: product!, policy, floor: policy ? Number(this.vault.decrypt(policy.floor_price_ciphertext)) : 0 };
  }

  private async invalidateOpenDeals(client: PoolClient, merchantId: string, productId: string, replacementPolicyId: string): Promise<void> {
    const invalidated = await client.query("UPDATE deal_sessions SET status='invalidated',updated_at=now() WHERE merchant_id=$1 AND product_id=$2 AND status IN ('negotiating','accepted','permit_created') RETURNING id,purchase_permit_id", [merchantId, productId]);
    for (const row of invalidated.rows) {
      if (row.purchase_permit_id) {
        await client.query("UPDATE intent_locks SET status='denied' WHERE id=$1 AND status IN ('pending_confirmation','confirmed')", [row.purchase_permit_id]);
        await this.store.appendAudit({ scopeType: "intent", scopeId: row.purchase_permit_id, merchantId, purchasePermitId: row.purchase_permit_id, eventType: "POLICY_DENIED", actor: "policy_engine", reasonCode: "DEAL_POLICY_CHANGED", payload: { dealSessionId: row.id, replacementPolicyId } }, client);
      }
      await this.store.appendAudit({ scopeType: "deal", scopeId: row.id, merchantId, purchasePermitId: row.purchase_permit_id, eventType: "DEAL_POLICY_INVALIDATED", actor: "merchant", reasonCode: "DEAL_POLICY_CHANGED", payload: { replacementPolicyId } }, client);
    }
  }

  private validateOffer(offerPaise: number, buyerMaxTotalPaise: number): void {
    if (!Number.isInteger(offerPaise) || offerPaise <= 0) throw new DealError(400, "NO_DEAL", "Buyer offer must be a positive whole-paise amount.");
    if (!Number.isInteger(buyerMaxTotalPaise) || buyerMaxTotalPaise <= 0 || offerPaise > buyerMaxTotalPaise) throw new DealError(400, "OFFER_ABOVE_BUYER_LIMIT", "The buyer offer cannot exceed the buyer's hard maximum.");
  }

  private mapPolicy(row: any, includeFloor: boolean): DealPolicy {
    return { id: row.id, merchantId: row.merchant_id, productId: row.product_id, version: row.version, active: row.active, minimumPricePaise: includeFloor && row.active ? Number(this.vault.decrypt(row.floor_price_ciphertext)) : null, createdBy: row.created_by, createdAt: iso(row.created_at) };
  }
}

function mapDeal(row: any, rounds: any[]): PriceNegotiation {
  return { id: row.id, buyerId: row.buyer_id, merchantId: row.merchant_id, productId: row.product_id, productName: row.product_name, productRevisionId: row.product_revision_id, productSnapshotHash: row.product_snapshot_hash, publicPricePaise: row.public_price_paise, buyerMaxTotalPaise: row.buyer_max_total_paise, policyVersion: row.policy_version, status: row.status, roundCount: row.round_count, acceptedPricePaise: row.accepted_price_paise, purchasePermitId: row.purchase_permit_id, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), rounds: rounds.map((round) => ({ sequence: round.sequence, buyerOfferPaise: round.buyer_offer_paise, response: round.response, merchantCounterPaise: round.merchant_counter_paise, reasonCode: round.reason_code, createdAt: iso(round.created_at) })) };
}

function mapPermit(row: any): PurchasePermit {
  return { id: row.id, buyerId: row.buyer_id, merchantId: row.merchant_id, productId: row.product_id, productRevisionId: row.product_revision_id, quantity: 1, currency: "INR", productSnapshotHash: row.product_snapshot_hash, lockedUnitPricePaise: row.locked_unit_price_paise, maxTotalPaise: row.max_total_paise, priceChangePolicy: row.price_change_policy, requireRefundable: row.require_refundable, minimumRefundWindowDays: row.minimum_refund_window_days, expiresAt: iso(row.expires_at), confirmationRequired: true, confirmedAt: row.confirmed_at ? iso(row.confirmed_at) : null, idempotencyKey: row.idempotency_key, status: row.status, createdAt: iso(row.created_at), negotiatedDeal: row.deal_session_id ? { dealSessionId: row.deal_session_id, dealPolicyId: row.deal_policy_id, dealPolicyVersion: row.deal_policy_version, publicUnitPricePaise: row.public_unit_price_paise, negotiatedUnitPricePaise: row.negotiated_unit_price_paise, buyerMaxTotalPaise: row.max_total_paise, acceptedOfferSnapshotHash: row.accepted_offer_snapshot_hash, dealExpiresAt: iso(row.deal_expires_at), savingsPaise: row.public_unit_price_paise - row.negotiated_unit_price_paise } : null };
}

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
