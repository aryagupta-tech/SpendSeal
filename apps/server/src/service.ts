import { randomBytes, randomUUID } from "node:crypto";
import { CreateIntentInputSchema, evaluatePurchasePermit, type CreateIntentInput, type PurchasePermit, type PolicyDecision } from "@spendseal/core";
import type { Config } from "./config.js";
import { CredentialVault } from "./credentials.js";
import { AmbiguousPaymentError, MockPaymentAdapter, RazorpayPaymentAdapter, type PaymentAdapter } from "./payments.js";
import { SpendSealStore, type CatalogConnection, type PaymentConfiguration } from "./store.js";
import { ShopifyAdminClient, ShopifyError } from "./shopify.js";

export class SpendSealService {
  readonly vault: CredentialVault;
  constructor(readonly store: SpendSealStore, readonly config: Config) {
    this.vault = new CredentialVault(config.credentialEncryptionKey, config.credentialEncryptionKeyVersion);
  }

  async createIntent(buyerId: string, raw: CreateIntentInput, actor: "chatgpt" | "buyer" = "chatgpt") {
    const input = CreateIntentInputSchema.parse(raw);
    const product = await this.store.getProduct(input.merchantId, input.productId);
    if (!product?.active) throw new SpendSealError(404, "PRODUCT_NOT_FOUND", "The merchant product is unavailable.");
    const created = await this.store.createIntent(buyerId, product, {
      maxTotalPaise: input.maxTotalPaise ?? product.pricePaise,
      priceChangePolicy: input.priceChangePolicy,
      requireRefundable: input.requireRefundable,
      minimumRefundWindowDays: input.minimumRefundWindowDays,
      expiresAt: new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString(),
    });
    if (actor === "buyer") await this.store.appendAudit({ scopeType: "intent", scopeId: created.intent.id, merchantId: created.intent.merchantId, purchasePermitId: created.intent.id, eventType: "STANDALONE_INTENT_SUBMITTED", actor: "buyer", reasonCode: null, payload: { source: "structured_form", buyerId } });
    return { intent: created.intent, product, approvalUrl: `${this.config.publicBaseUrl}/approve/${created.intent.id}?token=${encodeURIComponent(created.approvalToken)}` };
  }

  async prepareCheckout(buyerId: string, purchasePermitId: string): Promise<{ intent: PurchasePermit; decision: PolicyDecision; checkoutUrl?: string; orderStatus?: string }> {
    const initial = await this.store.getIntent(purchasePermitId, buyerId);
    if (!initial) throw new SpendSealError(404, "INTENT_NOT_FOUND", "PurchasePermit not found for this buyer.");
    const existingOrder = await this.store.getOrderByIntent(initial.id);
    const shopifyReference = !existingOrder ? await this.store.shopifyProductReference(initial.merchantId, initial.productId) : null;
    if (shopifyReference) {
      const connection = await this.store.catalogConnection(initial.merchantId);
      try {
        if (!connection || connection.provider !== "shopify") throw new ShopifyError("SHOPIFY_CONNECTION_MISSING", "The Shopify catalog connection is unavailable.");
        const client = new ShopifyAdminClient(connection.shopDomain, this.vault.decrypt(connection.accessTokenCiphertext));
        const observation = await client.productVariant(shopifyReference.externalId);
        await this.store.refreshShopifyProductForPolicy(initial.id, connection, observation);
      } catch (error) {
        const now = new Date().toISOString();
        const product = await this.store.getProduct(initial.merchantId, initial.productId);
        const decision: PolicyDecision = { allowed: false, reasons: ["CATALOG_REFRESH_FAILED"], message: "Checkout paused because SpendSeal could not re-check the authoritative Shopify product. No payment order was created.", evaluatedAt: now, observedAt: now, observedPricePaise: product?.pricePaise ?? 0, observedProductVersion: product?.version ?? null, observedProductRevisionId: product?.revisionId ?? null, observedProductSnapshotHash: product?.snapshotHash ?? null, catalogAuthority: product?.catalogAuthority ?? null };
        await this.store.appendAudit({ scopeType: "intent", scopeId: initial.id, merchantId: initial.merchantId, purchasePermitId: initial.id, eventType: "AUTHORITATIVE_PRODUCT_REFRESH_FAILED", actor: "policy_engine", reasonCode: "CATALOG_REFRESH_FAILED", payload: { source: "shopify_admin_graphql", errorCode: error instanceof ShopifyError ? error.code : "SHOPIFY_REQUEST_FAILED", decision } });
        return { intent: initial, decision };
      }
    }
    const paymentConfig = await this.store.paymentConfig(initial.merchantId);
    if (!paymentConfig) {
      const now = new Date().toISOString();
      const decision: PolicyDecision = { allowed: false, reasons: ["PAYMENT_CONFIG_MISSING"], message: "Checkout blocked: this merchant has not connected a Test Mode payment adapter.", evaluatedAt: now, observedAt: now, observedPricePaise: 0, observedProductVersion: null, observedProductRevisionId: null, observedProductSnapshotHash: null, catalogAuthority: null };
      await this.store.appendAudit({ scopeType: "intent", scopeId: initial.id, merchantId: initial.merchantId, purchasePermitId: initial.id, eventType: "POLICY_DENIED", actor: "policy_engine", reasonCode: "PAYMENT_CONFIG_MISSING", payload: { decision } });
      return { intent: initial, decision };
    }
    let preparation;
    try { preparation = await this.store.prepareOrderClaim(purchasePermitId, buyerId, evaluatePurchasePermit, paymentConfig.version); }
    catch (error) { if (error instanceof Error && error.message === "INTENT_NOT_FOUND") throw new SpendSealError(404, "INTENT_NOT_FOUND", "PurchasePermit not found for this buyer."); throw error; }

    if (preparation.kind === "denied") return { intent: preparation.intent, decision: preparation.decision };
    if (preparation.kind === "existing") {
      const now = new Date().toISOString();
      const decision: PolicyDecision = { allowed: false, reasons: ["REPLAY_DETECTED"], message: preparation.order.status === "ready" ? "The existing checkout is returned; no duplicate order was created." : "PurchasePermit already consumed. No duplicate order was created.", evaluatedAt: now, observedAt: preparation.order.observedAt, observedPricePaise: preparation.order.amountPaise, observedProductVersion: preparation.order.observedProductVersion, observedProductRevisionId: preparation.order.observedProductRevisionId, observedProductSnapshotHash: preparation.order.observedProductSnapshotHash, catalogAuthority: preparation.order.catalogAuthority };
      await this.store.appendAudit({ scopeType: "intent", scopeId: preparation.intent.id, merchantId: preparation.intent.merchantId, purchasePermitId: preparation.intent.id, eventType: "REPLAY_BLOCKED", actor: "policy_engine", reasonCode: "REPLAY_DETECTED", payload: { orderId: preparation.order.id, orderStatus: preparation.order.status } });
      return { intent: preparation.intent, decision, ...(preparation.order.status === "ready" ? { checkoutUrl: `${this.config.publicBaseUrl}/checkout/${preparation.order.checkoutToken}`, orderStatus: preparation.order.status } : {}) };
    }

    try {
      const adapter = this.adapter(paymentConfig);
      const providerOrder = await adapter.createOrder({ amountPaise: preparation.product.pricePaise, currency: "INR", receipt: preparation.intent.idempotencyKey, notes: { intent_lock_id: preparation.intent.id, merchant_id: preparation.intent.merchantId, buyer_id: preparation.intent.buyerId, product_id: preparation.intent.productId, observed_product_version: String(preparation.product.version), observed_revision_id: preparation.product.revisionId, observed_snapshot_hash: preparation.product.snapshotHash } });
      const order = await this.store.completeOrder(preparation.order.id, providerOrder.id, paymentConfig.adapter);
      return { intent: { ...preparation.intent, status: "checkout_ready" }, decision: preparation.decision, checkoutUrl: `${this.config.publicBaseUrl}/checkout/${order.checkoutToken}`, orderStatus: order.status };
    } catch (error) {
      await this.store.markReconciliation(preparation.order.id, error instanceof Error ? error.message : "Unknown provider error");
      throw new SpendSealError(502, "PAYMENT_PROVIDER_UNCERTAIN", error instanceof AmbiguousPaymentError ? "Payment provider state is uncertain. Automatic retry is blocked for reconciliation." : "Payment provider failed safely. Automatic retry is blocked for reconciliation.");
    }
  }

  async checkoutDetails(token: string) {
    const order = await this.store.getOrderByCheckoutToken(token);
    if (!order) throw new SpendSealError(404, "CHECKOUT_NOT_FOUND", "Checkout session not found.");
    const intent = await this.store.getIntent(order.purchasePermitId);
    const product = intent ? await this.store.getProduct(intent.merchantId, intent.productId) : null;
    const merchant = intent ? await this.store.getMerchant(intent.merchantId) : null;
    const paymentConfig = await this.store.paymentConfig(order.merchantId, order.paymentConfigVersion);
    if (!intent || !product || !merchant || !paymentConfig) throw new SpendSealError(409, "CHECKOUT_EVIDENCE_MISSING", "Checkout evidence is incomplete.");
    return { order, intent, product, merchant, keyId: paymentConfig.adapter === "mock" ? "rzp_test_spendseal_mock" : paymentConfig.keyId, adapter: paymentConfig.adapter };
  }

  async verifyPayment(input: { localOrderId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) {
    const order = await this.store.getOrder(input.localOrderId);
    if (!order || order.providerOrderId !== input.razorpayOrderId) throw new SpendSealError(400, "ORDER_MISMATCH", "Payment does not match the server-side order.");
    if (order.status === "paid") return order;
    const config = await this.store.paymentConfig(order.merchantId, order.paymentConfigVersion);
    if (!config || !this.adapter(config).verifyPayment(order.providerOrderId, input.razorpayPaymentId, input.razorpaySignature)) {
      await this.store.appendAudit({ scopeType: "intent", scopeId: order.purchasePermitId, merchantId: order.merchantId, purchasePermitId: order.purchasePermitId, eventType: "PAYMENT_SIGNATURE_REJECTED", actor: "policy_engine", reasonCode: "PAYMENT_SIGNATURE_INVALID", payload: { paymentId: input.razorpayPaymentId } });
      throw new SpendSealError(400, "PAYMENT_SIGNATURE_INVALID", "Payment signature verification failed.");
    }
    return this.store.markPaid(order.id, input.razorpayPaymentId, config.adapter);
  }

  async completeMockPayment(localOrderId: string) {
    const order = await this.store.getOrder(localOrderId); if (!order) throw new SpendSealError(404, "ORDER_NOT_FOUND", "Order not found.");
    const config = await this.store.paymentConfig(order.merchantId, order.paymentConfigVersion); if (!config || config.adapter !== "mock") throw new SpendSealError(404, "NOT_AVAILABLE", "Mock completion is disabled.");
    const adapter = this.adapter(config) as MockPaymentAdapter; const paymentId = `pay_mock_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    return this.verifyPayment({ localOrderId, razorpayOrderId: order.providerOrderId, razorpayPaymentId: paymentId, razorpaySignature: adapter.sign(order.providerOrderId, paymentId) });
  }

  async configurePayments(merchantId: string, input: { adapter: "mock" | "razorpay"; keyId?: string; keySecret?: string }): Promise<{ configuration: { adapter: string; keyId: string | null; version: number }; webhookSecret?: string; alreadyConnected?: boolean }> {
    if (input.adapter === "razorpay" && (!input.keyId?.startsWith("rzp_test_") || !input.keySecret)) throw new SpendSealError(400, "TEST_KEYS_REQUIRED", "Only complete Razorpay Test Mode credentials are accepted.");
    const existing = await this.store.paymentConfig(merchantId);
    if (input.adapter === "razorpay" && existing?.adapter === "razorpay" && existing.keyId === input.keyId && existing.keySecretCiphertext && this.vault.decrypt(existing.keySecretCiphertext) === input.keySecret) return { configuration: { adapter: existing.adapter, keyId: existing.keyId, version: existing.version }, alreadyConnected: true };
    if (input.adapter === "mock" && existing?.adapter === "mock") return { configuration: { adapter: existing.adapter, keyId: existing.keyId, version: existing.version }, alreadyConnected: true };
    if (input.adapter === "razorpay") { try { await new RazorpayPaymentAdapter(input.keyId!, input.keySecret!).verifyConnection(); } catch { throw new SpendSealError(400, "RAZORPAY_CREDENTIALS_INVALID", "Razorpay rejected these Test Mode credentials or could not be reached."); } }
    const webhookSecret = input.adapter === "razorpay" ? randomBytes(32).toString("hex") : undefined;
    const saved = await this.store.savePaymentConfig(merchantId, { adapter: input.adapter, keyId: input.adapter === "razorpay" ? input.keyId! : null, keySecretCiphertext: input.adapter === "razorpay" ? this.vault.encrypt(input.keySecret!) : null, webhookSecretCiphertext: webhookSecret ? this.vault.encrypt(webhookSecret) : null, encryptionKeyVersion: this.vault.version });
    await this.store.appendAudit({ scopeType: "merchant", scopeId: merchantId, merchantId, purchasePermitId: null, eventType: "PAYMENT_CONFIGURATION_ROTATED", actor: "merchant", reasonCode: null, payload: { adapter: saved.adapter, keyIdPrefix: saved.keyId?.slice(0, 12) ?? null, version: saved.version } });
    return { configuration: { adapter: saved.adapter, keyId: saved.keyId, version: saved.version }, ...(webhookSecret ? { webhookSecret } : {}) };
  }

  async rotateRazorpayWebhookSecret(merchantId: string): Promise<{ configuration: { adapter: "razorpay"; keyId: string; version: number }; webhookSecret: string }> {
    const existing = await this.store.paymentConfig(merchantId);
    if (!existing || existing.adapter !== "razorpay" || !existing.keyId || !existing.keySecretCiphertext) throw new SpendSealError(409, "RAZORPAY_NOT_CONNECTED", "Connect Razorpay Test Mode before rotating its webhook secret.");
    const webhookSecret = randomBytes(32).toString("hex");
    const saved = await this.store.savePaymentConfig(merchantId, { adapter: "razorpay", keyId: existing.keyId, keySecretCiphertext: existing.keySecretCiphertext, webhookSecretCiphertext: this.vault.encrypt(webhookSecret), encryptionKeyVersion: this.vault.version });
    await this.store.appendAudit({ scopeType: "merchant", scopeId: merchantId, merchantId, purchasePermitId: null, eventType: "RAZORPAY_WEBHOOK_SECRET_ROTATED", actor: "merchant", reasonCode: null, payload: { adapter: "razorpay", keyIdPrefix: saved.keyId?.slice(0, 12) ?? null, previousConfigurationVersion: existing.version, configurationVersion: saved.version, secretReturnedOnce: true } });
    return { configuration: { adapter: "razorpay", keyId: saved.keyId!, version: saved.version }, webhookSecret };
  }

  async configureShopify(merchantId: string, userId: string, input: { shopDomain: string; accessToken: string; defaultRefundable: boolean; defaultRefundWindowDays: number }) {
    try {
      const client = new ShopifyAdminClient(input.shopDomain, input.accessToken);
      const verified = await client.verify();
      const connection = await this.store.saveShopifyConnection({ merchantId, provider: "shopify", shopDomain: verified.shopDomain, accessTokenCiphertext: this.vault.encrypt(input.accessToken), encryptionKeyVersion: this.vault.version, shopName: verified.shopName, currency: verified.currency, defaultRefundable: input.defaultRefundable, defaultRefundWindowDays: input.defaultRefundable ? input.defaultRefundWindowDays : 0 });
      const sync = await this.syncShopify(merchantId, userId);
      return { connection: safeCatalogConnection(connection), sync };
    } catch (error) { throw shopifySpendSealError(error); }
  }

  async syncShopify(merchantId: string, userId: string) {
    const connection = await this.store.catalogConnection(merchantId);
    if (!connection || connection.provider !== "shopify") throw new SpendSealError(404, "SHOPIFY_NOT_CONNECTED", "Connect a Shopify store before synchronizing products.");
    try {
      const client = new ShopifyAdminClient(connection.shopDomain, this.vault.decrypt(connection.accessTokenCiphertext));
      await client.verify();
      return await this.store.syncShopifyProducts(userId, connection, await client.products());
    } catch (error) { throw shopifySpendSealError(error); }
  }

  adapter(config: PaymentConfiguration): PaymentAdapter {
    if (config.adapter === "mock") return new MockPaymentAdapter();
    if (!config.keyId || !config.keySecretCiphertext) throw new SpendSealError(409, "PAYMENT_CONFIG_MISSING", "Merchant payment credentials are incomplete.");
    return new RazorpayPaymentAdapter(config.keyId, this.vault.decrypt(config.keySecretCiphertext));
  }
}

function safeCatalogConnection(connection: CatalogConnection) {
  return { provider: connection.provider, shopDomain: connection.shopDomain, shopName: connection.shopName, currency: connection.currency, status: connection.status, defaultRefundable: connection.defaultRefundable, defaultRefundWindowDays: connection.defaultRefundWindowDays, lastSyncAt: connection.lastSyncAt, connected: true };
}

function shopifySpendSealError(error: unknown): SpendSealError {
  if (error instanceof ShopifyError) return new SpendSealError(error.code === "SHOPIFY_UNREACHABLE" || error.code === "SHOPIFY_REQUEST_FAILED" ? 502 : 400, error.code, error.message);
  if (error instanceof SpendSealError) return error;
  return new SpendSealError(502, "SHOPIFY_REQUEST_FAILED", "Shopify synchronization failed safely.");
}

export class SpendSealError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
