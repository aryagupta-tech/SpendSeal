import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import {
  CATALOG_AUTHORITY,
  REFUND_TERMS_AUTHORITY,
  hashAuditPayload,
  sha256,
  type AuditActor,
  type AuditEvent,
  type IntentLock,
  type PaymentOrder,
  type Product,
  type ReasonCode,
} from "@agentrail/core";

type Row = Record<string, unknown>;

export type DemoBuyer = { id: string; username: string; displayName: string; passkeyEnrolled: boolean };
export type StoredPasskey = {
  id: string;
  buyerId: string;
  rpId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
};
export type StoredChallenge = { id: string; challenge: string };

export class AgentRailDatabase {
  readonly db: Database.Database;

  constructor(filename: string) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.seed();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS demo_runs (
        id TEXT PRIMARY KEY,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON demo_runs(active) WHERE active = 1;

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        price_paise INTEGER NOT NULL CHECK(price_paise > 0),
        currency TEXT NOT NULL CHECK(currency = 'INR'),
        refundable INTEGER NOT NULL,
        refund_window_days INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS intent_locks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity = 1),
        currency TEXT NOT NULL CHECK(currency = 'INR'),
        product_snapshot_hash TEXT NOT NULL,
        locked_unit_price_paise INTEGER NOT NULL,
        max_total_paise INTEGER NOT NULL,
        price_change_policy TEXT NOT NULL,
        require_refundable INTEGER NOT NULL,
        minimum_refund_window_days INTEGER,
        expires_at TEXT NOT NULL,
        confirmation_required INTEGER NOT NULL DEFAULT 1,
        confirmed_at TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        approval_token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(product_id) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS payment_orders (
        id TEXT PRIMARY KEY,
        intent_lock_id TEXT NOT NULL UNIQUE,
        provider_order_id TEXT UNIQUE,
        amount_paise INTEGER NOT NULL,
        currency TEXT NOT NULL CHECK(currency = 'INR'),
        checkout_token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        payment_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY(intent_lock_id) REFERENCES intent_locks(id)
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        intent_lock_id TEXT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason_code TEXT,
        payload_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS audit_events_no_update
      BEFORE UPDATE ON audit_events BEGIN
        SELECT RAISE(ABORT, 'audit_events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
      BEFORE DELETE ON audit_events BEGIN
        SELECT RAISE(ABORT, 'audit_events are append-only');
      END;
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
    this.applyPasskeyAndEvidenceMigration();
    this.applyPasskeyRpMigration();
  }

  private applyPasskeyAndEvidenceMigration(): void {
    if (this.db.prepare("SELECT version FROM schema_migrations WHERE version = 2").get()) return;
    const migration = this.db.transaction(() => {
      this.ensureColumn("intent_locks", "approval_token_exchanged_at", "ALTER TABLE intent_locks ADD COLUMN approval_token_exchanged_at TEXT");
      this.ensureColumn("payment_orders", "observed_product_version", "ALTER TABLE payment_orders ADD COLUMN observed_product_version INTEGER NOT NULL DEFAULT 1");
      this.ensureColumn("payment_orders", "observed_snapshot_hash", "ALTER TABLE payment_orders ADD COLUMN observed_snapshot_hash TEXT NOT NULL DEFAULT 'legacy_unavailable'");
      this.ensureColumn("payment_orders", "catalog_authority", `ALTER TABLE payment_orders ADD COLUMN catalog_authority TEXT NOT NULL DEFAULT '${CATALOG_AUTHORITY}'`);
      this.ensureColumn("payment_orders", "observed_at", "ALTER TABLE payment_orders ADD COLUMN observed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS demo_buyers (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS passkey_credentials (
          credential_id TEXT PRIMARY KEY,
          buyer_id TEXT NOT NULL,
          rp_id TEXT NOT NULL,
          public_key BLOB NOT NULL,
          counter INTEGER NOT NULL,
          device_type TEXT NOT NULL,
          backed_up INTEGER NOT NULL,
          transports_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(buyer_id) REFERENCES demo_buyers(id)
        );
        CREATE TABLE IF NOT EXISTS webauthn_challenges (
          id TEXT PRIMARY KEY,
          buyer_id TEXT NOT NULL,
          intent_lock_id TEXT,
          purpose TEXT NOT NULL CHECK(purpose IN ('registration', 'authentication')),
          challenge TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(buyer_id) REFERENCES demo_buyers(id),
          FOREIGN KEY(intent_lock_id) REFERENCES intent_locks(id)
        );
        CREATE TABLE IF NOT EXISTS approval_sessions (
          token_hash TEXT PRIMARY KEY,
          intent_lock_id TEXT NOT NULL,
          buyer_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(intent_lock_id) REFERENCES intent_locks(id),
          FOREIGN KEY(buyer_id) REFERENCES demo_buyers(id)
        );
        CREATE INDEX IF NOT EXISTS approval_sessions_intent ON approval_sessions(intent_lock_id);
        CREATE INDEX IF NOT EXISTS webauthn_challenges_lookup ON webauthn_challenges(buyer_id, intent_lock_id, purpose);
      `);
      this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(new Date().toISOString());
    });
    migration();
  }

  private applyPasskeyRpMigration(): void {
    if (this.db.prepare("SELECT version FROM schema_migrations WHERE version = 3").get()) return;
    const migration = this.db.transaction(() => {
      this.ensureColumn("passkey_credentials", "rp_id", "ALTER TABLE passkey_credentials ADD COLUMN rp_id TEXT NOT NULL DEFAULT 'legacy_unknown'");
      this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(new Date().toISOString());
    });
    migration();
  }

  private ensureColumn(table: string, column: string, statement: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((entry) => String(entry.name) === column)) this.db.exec(statement);
  }

  private seed(): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO products
      (id, merchant_id, name, description, price_paise, currency, refundable, refund_window_days, active, version)
      VALUES (?, 'novadesk', ?, ?, ?, 'INR', ?, ?, 1, 1)
    `);
    const seed = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO demo_buyers (id, username, display_name, created_at) VALUES ('demo-buyer', 'buyer@agentrail.demo', 'AgentRail Demo Buyer', ?)").run(new Date().toISOString());
      insert.run("starter", "Starter", "Essential focus tools for individuals.", 49_900, 0, 0);
      insert.run("pro-annual", "Pro Annual", "Automation and collaboration for growing teams.", 99_900, 1, 7);
      insert.run("business-annual", "Business Annual", "Governance and analytics for established teams.", 149_900, 1, 14);
      if (!this.db.prepare("SELECT id FROM demo_runs WHERE active = 1").get()) {
        this.createDemoRun("policy_engine");
      }
    });
    seed();
  }

  currentRunId(): string {
    const row = this.db.prepare("SELECT id FROM demo_runs WHERE active = 1").get() as Row | undefined;
    if (!row) throw new Error("No active demo run");
    return String(row.id);
  }

  getDemoBuyer(rpId?: string): DemoBuyer {
    const row = this.db.prepare("SELECT id, username, display_name FROM demo_buyers WHERE id = 'demo-buyer'").get() as Row;
    const credential = rpId
      ? this.db.prepare("SELECT 1 FROM passkey_credentials WHERE buyer_id = ? AND rp_id = ? LIMIT 1").get(String(row.id), rpId)
      : this.db.prepare("SELECT 1 FROM passkey_credentials WHERE buyer_id = ? LIMIT 1").get(String(row.id));
    return { id: String(row.id), username: String(row.username), displayName: String(row.display_name), passkeyEnrolled: Boolean(credential) };
  }

  listPasskeys(buyerId = "demo-buyer", rpId?: string): StoredPasskey[] {
    const rows = rpId
      ? this.db.prepare("SELECT * FROM passkey_credentials WHERE buyer_id = ? AND rp_id = ? ORDER BY created_at").all(buyerId, rpId)
      : this.db.prepare("SELECT * FROM passkey_credentials WHERE buyer_id = ? ORDER BY created_at").all(buyerId);
    return (rows as Row[]).map(mapPasskey);
  }

  getPasskey(credentialId: string, rpId?: string): StoredPasskey | null {
    const row = rpId
      ? this.db.prepare("SELECT * FROM passkey_credentials WHERE credential_id = ? AND rp_id = ?").get(credentialId, rpId) as Row | undefined
      : this.db.prepare("SELECT * FROM passkey_credentials WHERE credential_id = ?").get(credentialId) as Row | undefined;
    return row ? mapPasskey(row) : null;
  }

  savePasskey(input: StoredPasskey): void {
    this.db.prepare(`INSERT INTO passkey_credentials
      (credential_id, buyer_id, rp_id, public_key, counter, device_type, backed_up, transports_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(input.id, input.buyerId, input.rpId, Buffer.from(input.publicKey), input.counter, input.deviceType, Number(input.backedUp), JSON.stringify(input.transports), new Date().toISOString());
  }

  updatePasskeyCounter(credentialId: string, counter: number): void {
    this.db.prepare("UPDATE passkey_credentials SET counter = ? WHERE credential_id = ?").run(counter, credentialId);
  }

  createWebAuthnChallenge(input: { buyerId?: string; intentLockId?: string | null; purpose: "registration" | "authentication"; challenge: string }): StoredChallenge {
    const id = randomUUID();
    const now = new Date();
    this.db.prepare(`INSERT INTO webauthn_challenges
      (id, buyer_id, intent_lock_id, purpose, challenge, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(id, input.buyerId ?? "demo-buyer", input.intentLockId ?? null, input.purpose, input.challenge, new Date(now.getTime() + 5 * 60_000).toISOString(), now.toISOString());
    return { id, challenge: input.challenge };
  }

  consumeWebAuthnChallenge(input: { id: string; buyerId?: string; intentLockId?: string | null; purpose: "registration" | "authentication" }): StoredChallenge | null {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id, challenge, expires_at, consumed_at FROM webauthn_challenges
        WHERE id = ? AND buyer_id = ? AND purpose = ? AND intent_lock_id IS ?`
      ).get(input.id, input.buyerId ?? "demo-buyer", input.purpose, input.intentLockId ?? null) as Row | undefined;
      if (!row || row.consumed_at || new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
      this.db.prepare("UPDATE webauthn_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(new Date().toISOString(), input.id);
      return { id: String(row.id), challenge: String(row.challenge) };
    });
    return transaction();
  }

  exchangeApprovalToken(intentLockId: string, token: string): { sessionToken: string; expiresAt: string } | null {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT approval_token_hash, approval_token_exchanged_at, status, expires_at FROM intent_locks WHERE id = ?").get(intentLockId) as Row | undefined;
      if (!row || !safeHashEqual(sha256(token), String(row.approval_token_hash)) || row.approval_token_exchanged_at || row.status !== "pending_confirmation" || new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
      const sessionToken = randomBytes(32).toString("base64url");
      const now = new Date().toISOString();
      this.db.prepare("UPDATE intent_locks SET approval_token_exchanged_at = ? WHERE id = ? AND approval_token_exchanged_at IS NULL").run(now, intentLockId);
      this.db.prepare(`INSERT INTO approval_sessions (token_hash, intent_lock_id, buyer_id, expires_at, used_at, created_at)
        VALUES (?, ?, 'demo-buyer', ?, NULL, ?)`
      ).run(sha256(sessionToken), intentLockId, String(row.expires_at), now);
      return { sessionToken, expiresAt: String(row.expires_at) };
    });
    return transaction();
  }

  getApprovalSession(intentLockId: string, sessionToken: string): { buyerId: string } | null {
    const row = this.db.prepare("SELECT buyer_id, expires_at, used_at FROM approval_sessions WHERE token_hash = ? AND intent_lock_id = ?").get(sha256(sessionToken), intentLockId) as Row | undefined;
    if (!row || row.used_at || new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
    return { buyerId: String(row.buyer_id) };
  }

  consumeApprovalSession(intentLockId: string, sessionToken: string): boolean {
    const result = this.db.prepare("UPDATE approval_sessions SET used_at = ? WHERE token_hash = ? AND intent_lock_id = ? AND used_at IS NULL AND expires_at > ?").run(new Date().toISOString(), sha256(sessionToken), intentLockId, new Date().toISOString());
    return result.changes === 1;
  }

  completePasskeyApproval(input: { intentLockId: string; sessionToken: string; credentialId: string; newCounter: number; deviceType: string; backedUp: boolean; userVerified: boolean }): IntentLock | null {
    const transaction = this.db.transaction(() => {
      const session = this.getApprovalSession(input.intentLockId, input.sessionToken);
      const current = this.getIntent(input.intentLockId);
      if (!session || !current || current.status !== "pending_confirmation") return null;
      if (!this.consumeApprovalSession(input.intentLockId, input.sessionToken)) return null;
      this.updatePasskeyCounter(input.credentialId, input.newCounter);
      const confirmedAt = new Date().toISOString();
      this.db.prepare("UPDATE intent_locks SET confirmed_at = ?, status = 'confirmed' WHERE id = ?").run(confirmedAt, input.intentLockId);
      this.appendAudit({ runId: current.runId, intentLockId: current.id, eventType: "PASSKEY_VERIFIED", actor: "buyer", reasonCode: null, payload: { credentialIdHash: sha256(input.credentialId), deviceType: input.deviceType, backedUp: input.backedUp, userVerified: input.userVerified } });
      this.appendAudit({ runId: current.runId, intentLockId: current.id, eventType: "HUMAN_CONFIRMATION_RECORDED", actor: "buyer", reasonCode: null, payload: { confirmedAt, method: "passkey", identityAssurance: "device-bound-demo-buyer-not-kyc" } });
      return this.getIntent(input.intentLockId)!;
    });
    return transaction();
  }

  completeInsecureDemoApproval(intentLockId: string, sessionToken: string): IntentLock | null {
    const transaction = this.db.transaction(() => {
      const session = this.getApprovalSession(intentLockId, sessionToken);
      const current = this.getIntent(intentLockId);
      if (!session || !current || current.status !== "pending_confirmation") return null;
      if (!this.consumeApprovalSession(intentLockId, sessionToken)) return null;
      const confirmedAt = new Date().toISOString();
      this.db.prepare("UPDATE intent_locks SET confirmed_at = ?, status = 'confirmed' WHERE id = ?").run(confirmedAt, intentLockId);
      this.appendAudit({ runId: current.runId, intentLockId, eventType: "INSECURE_DEMO_APPROVAL", actor: "buyer", reasonCode: null, payload: { confirmedAt, warning: "Mock-only approval without identity verification" } });
      this.appendAudit({ runId: current.runId, intentLockId, eventType: "HUMAN_CONFIRMATION_RECORDED", actor: "buyer", reasonCode: null, payload: { confirmedAt, method: "insecure-demo", identityAssurance: "none" } });
      return this.getIntent(intentLockId)!;
    });
    return transaction();
  }

  createDemoRun(actor: AuditActor = "merchant"): string {
    const runId = randomUUID();
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE demo_runs SET active = 0 WHERE active = 1").run();
      this.db.prepare("INSERT INTO demo_runs (id, active, created_at) VALUES (?, 1, ?)").run(runId, now);
      this.db.prepare("UPDATE products SET price_paise = CASE id WHEN 'starter' THEN 49900 WHEN 'pro-annual' THEN 99900 WHEN 'business-annual' THEN 149900 END, refundable = CASE id WHEN 'starter' THEN 0 ELSE 1 END, refund_window_days = CASE id WHEN 'starter' THEN 0 WHEN 'pro-annual' THEN 7 ELSE 14 END, active = 1, version = version + 1").run();
      this.appendAudit({ runId, intentLockId: null, eventType: "DEMO_RUN_STARTED", actor, reasonCode: null, payload: { resetCatalog: true } });
    });
    transaction();
    return runId;
  }

  listProducts(query?: string): Product[] {
    const rows = query
      ? (this.db.prepare("SELECT * FROM products WHERE active = 1 AND (name LIKE ? OR description LIKE ?) ORDER BY price_paise").all(`%${query}%`, `%${query}%`) as Row[])
      : (this.db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY price_paise").all() as Row[]);
    return rows.map(mapProduct);
  }

  getProduct(id: string): Product | null {
    const row = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as Row | undefined;
    return row ? mapProduct(row) : null;
  }

  updateProduct(id: string, fields: { pricePaise?: number; refundable?: boolean; refundWindowDays?: number }): Product | null {
    const product = this.getProduct(id);
    if (!product) return null;
    this.db.prepare(`UPDATE products SET price_paise = ?, refundable = ?, refund_window_days = ?, version = version + 1 WHERE id = ?`).run(
      fields.pricePaise ?? product.pricePaise,
      Number(fields.refundable ?? product.refundable),
      fields.refundWindowDays ?? product.refundWindowDays,
      id,
    );
    const updated = this.getProduct(id)!;
    this.appendAudit({ runId: this.currentRunId(), intentLockId: null, eventType: "CATALOG_CHANGED", actor: "merchant", reasonCode: null, payload: { before: product, after: updated } });
    return updated;
  }

  createIntent(data: Omit<IntentLock, "id" | "runId" | "idempotencyKey" | "status" | "createdAt" | "confirmedAt">): { intent: IntentLock; approvalToken: string } {
    const id = randomUUID();
    const runId = this.currentRunId();
    const idempotencyKey = `intent_${randomUUID()}`;
    const approvalToken = randomBytes(24).toString("base64url");
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO intent_locks (
        id, run_id, merchant_id, product_id, quantity, currency, product_snapshot_hash,
        locked_unit_price_paise, max_total_paise, price_change_policy, require_refundable,
        minimum_refund_window_days, expires_at, confirmation_required, confirmed_at,
        idempotency_key, approval_token_hash, status, created_at
      ) VALUES (?, ?, ?, ?, 1, 'INR', ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, 'pending_confirmation', ?)
    `).run(
      id, runId, data.merchantId, data.productId, data.productSnapshotHash,
      data.lockedUnitPricePaise, data.maxTotalPaise, data.priceChangePolicy,
      Number(data.requireRefundable), data.minimumRefundWindowDays, data.expiresAt,
      idempotencyKey, sha256(approvalToken), createdAt,
    );
    const intent = this.getIntent(id)!;
    this.appendAudit({ runId, intentLockId: id, eventType: "INTENT_LOCK_CREATED", actor: "chatgpt", reasonCode: null, payload: { intent } });
    return { intent, approvalToken };
  }

  getIntent(id: string): IntentLock | null {
    const row = this.db.prepare("SELECT * FROM intent_locks WHERE id = ?").get(id) as Row | undefined;
    return row ? mapIntent(row) : null;
  }

  approveIntent(id: string): IntentLock | null {
    const row = this.db.prepare("SELECT status FROM intent_locks WHERE id = ?").get(id) as Row | undefined;
    if (!row || row.status !== "pending_confirmation") return null;
    const confirmedAt = new Date().toISOString();
    this.db.prepare("UPDATE intent_locks SET confirmed_at = ?, status = 'confirmed' WHERE id = ?").run(confirmedAt, id);
    const intent = this.getIntent(id)!;
    this.appendAudit({ runId: intent.runId, intentLockId: id, eventType: "HUMAN_CONFIRMATION_RECORDED", actor: "buyer", reasonCode: null, payload: { confirmedAt } });
    return intent;
  }

  updateIntentStatus(id: string, status: IntentLock["status"]): IntentLock {
    this.db.prepare("UPDATE intent_locks SET status = ? WHERE id = ?").run(status, id);
    const intent = this.getIntent(id);
    if (!intent) throw new Error("IntentLock not found");
    return intent;
  }

  claimOrder(intent: IntentLock, product: Product, observedAt: string): { order: PaymentOrder; claimed: boolean } {
    const existing = this.getOrderByIntent(intent.id);
    if (existing) return { order: existing, claimed: false };
    const order: PaymentOrder = {
      id: randomUUID(),
      intentLockId: intent.id,
      providerOrderId: "pending",
      amountPaise: product.pricePaise,
      currency: "INR",
      checkoutToken: randomBytes(24).toString("base64url"),
      status: "creating",
      paymentId: null,
      createdAt: new Date().toISOString(),
      observedProductVersion: product.version,
      observedProductSnapshotHash: sha256(product),
      catalogAuthority: CATALOG_AUTHORITY,
      observedAt,
    };
    try {
      this.db.prepare(`INSERT INTO payment_orders
        (id, intent_lock_id, provider_order_id, amount_paise, currency, checkout_token, status, payment_id, created_at,
         observed_product_version, observed_snapshot_hash, catalog_authority, observed_at)
        VALUES (?, ?, NULL, ?, 'INR', ?, 'creating', NULL, ?, ?, ?, ?, ?)`
      ).run(order.id, order.intentLockId, product.pricePaise, order.checkoutToken, order.createdAt, order.observedProductVersion, order.observedProductSnapshotHash, order.catalogAuthority, order.observedAt);
      this.updateIntentStatus(intent.id, "executing");
      return { order, claimed: true };
    } catch (error) {
      const raced = this.getOrderByIntent(intent.id);
      if (raced) return { order: raced, claimed: false };
      throw error;
    }
  }

  completeOrderClaim(orderId: string, providerOrderId: string): PaymentOrder {
    this.db.prepare("UPDATE payment_orders SET provider_order_id = ?, status = 'ready' WHERE id = ?").run(providerOrderId, orderId);
    const order = this.getOrder(orderId)!;
    this.updateIntentStatus(order.intentLockId, "checkout_ready");
    return order;
  }

  markReconciliationRequired(orderId: string): PaymentOrder {
    this.db.prepare("UPDATE payment_orders SET status = 'reconciliation_required' WHERE id = ?").run(orderId);
    const order = this.getOrder(orderId)!;
    this.updateIntentStatus(order.intentLockId, "reconciliation_required");
    return order;
  }

  markPaid(orderId: string, paymentId: string): PaymentOrder {
    this.db.prepare("UPDATE payment_orders SET status = 'paid', payment_id = ? WHERE id = ? AND status != 'paid'").run(paymentId, orderId);
    const order = this.getOrder(orderId)!;
    this.updateIntentStatus(order.intentLockId, "paid");
    return order;
  }

  getOrder(id: string): PaymentOrder | null {
    const row = this.db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(id) as Row | undefined;
    return row ? mapOrder(row) : null;
  }

  getOrderByIntent(intentLockId: string): PaymentOrder | null {
    const row = this.db.prepare("SELECT * FROM payment_orders WHERE intent_lock_id = ?").get(intentLockId) as Row | undefined;
    return row ? mapOrder(row) : null;
  }

  getOrderByCheckoutToken(token: string): PaymentOrder | null {
    const row = this.db.prepare("SELECT * FROM payment_orders WHERE checkout_token = ?").get(token) as Row | undefined;
    return row ? mapOrder(row) : null;
  }

  getOrderByProviderId(providerOrderId: string): PaymentOrder | null {
    const row = this.db.prepare("SELECT * FROM payment_orders WHERE provider_order_id = ?").get(providerOrderId) as Row | undefined;
    return row ? mapOrder(row) : null;
  }

  listOrders(): PaymentOrder[] {
    return (this.db.prepare("SELECT * FROM payment_orders ORDER BY created_at DESC").all() as Row[]).map(mapOrder);
  }

  recordWebhook(eventId: string, eventType: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO webhook_events (event_id, event_type, created_at) VALUES (?, ?, ?)").run(eventId, eventType, new Date().toISOString());
    return result.changes === 1;
  }

  appendAudit(input: { runId: string; intentLockId: string | null; eventType: string; actor: AuditActor; reasonCode: ReasonCode | null; payload: unknown }): AuditEvent {
    const previous = this.db.prepare("SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1").get() as Row | undefined;
    const previousHash = previous ? String(previous.hash) : "GENESIS";
    const createdAt = new Date().toISOString();
    const hashable = { ...input, previousHash, createdAt };
    const hash = hashAuditPayload(previousHash, hashable);
    const result = this.db.prepare(`INSERT INTO audit_events (run_id, intent_lock_id, event_type, actor, reason_code, payload_json, previous_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.runId, input.intentLockId, input.eventType, input.actor, input.reasonCode, JSON.stringify(input.payload), previousHash, hash, createdAt,
    );
    return { sequence: Number(result.lastInsertRowid), ...input, previousHash, hash, createdAt };
  }

  getAuditTrail(intentLockId?: string, runId?: string): AuditEvent[] {
    let rows: Row[];
    if (intentLockId) rows = this.db.prepare("SELECT * FROM audit_events WHERE intent_lock_id = ? ORDER BY sequence").all(intentLockId) as Row[];
    else if (runId) rows = this.db.prepare("SELECT * FROM audit_events WHERE run_id = ? ORDER BY sequence").all(runId) as Row[];
    else rows = this.db.prepare("SELECT * FROM audit_events ORDER BY sequence").all() as Row[];
    return rows.map(mapAudit);
  }

  verifyAuditChain(): { valid: boolean; checked: number; brokenAt: number | null } {
    const events = this.getAuditTrail();
    let previousHash = "GENESIS";
    for (const event of events) {
      const hashable = {
        runId: event.runId,
        intentLockId: event.intentLockId,
        eventType: event.eventType,
        actor: event.actor,
        reasonCode: event.reasonCode,
        payload: event.payload,
        previousHash: event.previousHash,
        createdAt: event.createdAt,
      };
      if (event.previousHash !== previousHash || hashAuditPayload(previousHash, hashable) !== event.hash) {
        return { valid: false, checked: event.sequence - 1, brokenAt: event.sequence };
      }
      previousHash = event.hash;
    }
    return { valid: true, checked: events.length, brokenAt: null };
  }
}

function mapProduct(row: Row): Product {
  return { id: String(row.id), merchantId: String(row.merchant_id), name: String(row.name), description: String(row.description), pricePaise: Number(row.price_paise), currency: "INR", refundable: Boolean(row.refundable), refundWindowDays: Number(row.refund_window_days), active: Boolean(row.active), version: Number(row.version), catalogAuthority: CATALOG_AUTHORITY, refundTermsAuthority: REFUND_TERMS_AUTHORITY };
}
function mapIntent(row: Row): IntentLock {
  return { id: String(row.id), runId: String(row.run_id), merchantId: String(row.merchant_id), productId: String(row.product_id), quantity: 1, currency: "INR", productSnapshotHash: String(row.product_snapshot_hash), lockedUnitPricePaise: Number(row.locked_unit_price_paise), maxTotalPaise: Number(row.max_total_paise), priceChangePolicy: row.price_change_policy as IntentLock["priceChangePolicy"], requireRefundable: Boolean(row.require_refundable), minimumRefundWindowDays: row.minimum_refund_window_days === null ? null : Number(row.minimum_refund_window_days), expiresAt: String(row.expires_at), confirmationRequired: true, confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null, idempotencyKey: String(row.idempotency_key), status: row.status as IntentLock["status"], createdAt: String(row.created_at) };
}
function mapOrder(row: Row): PaymentOrder {
  return { id: String(row.id), intentLockId: String(row.intent_lock_id), providerOrderId: row.provider_order_id ? String(row.provider_order_id) : "pending", amountPaise: Number(row.amount_paise), currency: "INR", checkoutToken: String(row.checkout_token), status: row.status as PaymentOrder["status"], paymentId: row.payment_id ? String(row.payment_id) : null, createdAt: String(row.created_at), observedProductVersion: Number(row.observed_product_version), observedProductSnapshotHash: String(row.observed_snapshot_hash), catalogAuthority: CATALOG_AUTHORITY, observedAt: String(row.observed_at) };
}

function mapPasskey(row: Row): StoredPasskey {
  return { id: String(row.credential_id), buyerId: String(row.buyer_id), rpId: String(row.rp_id), publicKey: Uint8Array.from(row.public_key as Buffer), counter: Number(row.counter), deviceType: String(row.device_type), backedUp: Boolean(row.backed_up), transports: JSON.parse(String(row.transports_json)) as string[] };
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
function mapAudit(row: Row): AuditEvent {
  return { sequence: Number(row.sequence), runId: String(row.run_id), intentLockId: row.intent_lock_id ? String(row.intent_lock_id) : null, eventType: String(row.event_type), actor: row.actor as AuditActor, reasonCode: row.reason_code ? (String(row.reason_code) as ReasonCode) : null, payload: JSON.parse(String(row.payload_json)), previousHash: String(row.previous_hash), hash: String(row.hash), createdAt: String(row.created_at) };
}
