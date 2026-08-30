import { boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey(), username: text("username").notNull().unique(), displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"), createdAt: createdAt(),
});

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey(), slug: text("slug").notNull().unique(), displayName: text("display_name").notNull(), status: text("status").notNull().default("active"),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const merchantMemberships = pgTable("merchant_memberships", {
  merchantId: uuid("merchant_id").notNull().references(() => merchants.id), userId: uuid("user_id").notNull().references(() => users.id), role: text("role").notNull(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.merchantId, table.userId] }), index("memberships_user_idx").on(table.userId)]);

export const merchantInvitations = pgTable("merchant_invitations", {
  id: uuid("id").primaryKey(), merchantId: uuid("merchant_id").notNull().references(() => merchants.id), invitedUsername: text("invited_username").notNull(),
  role: text("role").notNull(), tokenHash: text("token_hash").notNull().unique(), createdBy: uuid("created_by").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }), revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }), createdAt: createdAt(),
}, (table) => [index("merchant_invitations_merchant_idx").on(table.merchantId, table.createdAt)]);

export const sessions = pgTable("browser_sessions", {
  tokenHash: text("token_hash").primaryKey(), userId: uuid("user_id").notNull().references(() => users.id), csrfHash: text("csrf_hash").notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true, mode: "string" }).notNull(), absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true, mode: "string" }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull(), createdAt: createdAt(),
}, (table) => [index("sessions_user_idx").on(table.userId)]);

export const passkeyCredentials = pgTable("passkey_credentials", {
  credentialId: text("credential_id").primaryKey(), userId: uuid("user_id").notNull().references(() => users.id), rpId: text("rp_id").notNull(), publicKey: text("public_key_b64").notNull(),
  counter: integer("counter").notNull(), deviceType: text("device_type").notNull(), backedUp: boolean("backed_up").notNull(), transports: jsonb("transports_json").notNull(), createdAt: createdAt(),
}, (table) => [index("passkeys_user_rp_idx").on(table.userId, table.rpId)]);

export const webauthnChallenges = pgTable("webauthn_challenges", {
  id: uuid("id").primaryKey(), userId: uuid("user_id").references(() => users.id), purchasePermitId: uuid("intent_lock_id"), purpose: text("purpose").notNull(), challenge: text("challenge").notNull(),
  shoppingTaskId: uuid("shopping_task_id"), context: jsonb("context_json").notNull().default({}), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }), createdAt: createdAt(),
});

export const apiKeys = pgTable("merchant_api_keys", {
  id: uuid("id").primaryKey(), merchantId: uuid("merchant_id").notNull().references(() => merchants.id), name: text("name").notNull(), prefix: text("prefix").notNull(), secretHash: text("secret_hash").notNull().unique(),
  scopes: jsonb("scopes_json").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }), lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }), revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }), createdAt: createdAt(),
}, (table) => [index("api_keys_merchant_idx").on(table.merchantId)]);

export const products = pgTable("products", {
  id: uuid("id").primaryKey(), merchantId: uuid("merchant_id").notNull().references(() => merchants.id), sku: text("sku").notNull(), name: text("name").notNull(), description: text("description").notNull().default(""),
  pricePaise: integer("price_paise").notNull(), currency: text("currency").notNull().default("INR"), refundable: boolean("refundable").notNull(), refundWindowDays: integer("refund_window_days").notNull(), active: boolean("active").notNull().default(true), version: integer("version").notNull().default(1),
  currentRevisionId: uuid("current_revision_id").notNull(), catalogSource: text("catalog_source").notNull().default("agentrail_server"), externalId: text("external_id"), externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true, mode: "string" }), createdAt: createdAt(), updatedAt: updatedAt(),
}, (table) => [uniqueIndex("products_merchant_sku_unique").on(table.merchantId, table.sku), uniqueIndex("products_merchant_id_unique").on(table.merchantId, table.id), index("products_search_idx").on(table.merchantId, table.active)]);

export const catalogConnections = pgTable("merchant_catalog_connections", {
  merchantId: uuid("merchant_id").primaryKey().references(() => merchants.id), provider: text("provider").notNull(), shopDomain: text("shop_domain").notNull().unique(),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(), encryptionKeyVersion: integer("encryption_key_version").notNull(), status: text("status").notNull().default("active"),
  shopName: text("shop_name").notNull(), currency: text("currency").notNull(), defaultRefundable: boolean("default_refundable").notNull().default(false), defaultRefundWindowDays: integer("default_refund_window_days").notNull().default(0),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "string" }), createdAt: createdAt(), updatedAt: updatedAt(),
});

export const productRevisions = pgTable("product_revisions", {
  id: uuid("id").primaryKey(), merchantId: uuid("merchant_id").notNull().references(() => merchants.id), productId: uuid("product_id").notNull().references(() => products.id), version: integer("version").notNull(),
  snapshot: jsonb("snapshot_json").notNull(), snapshotHash: text("snapshot_hash").notNull(), createdBy: uuid("created_by").references(() => users.id), createdAt: createdAt(),
}, (table) => [uniqueIndex("product_revisions_version_unique").on(table.productId, table.version), uniqueIndex("product_revisions_merchant_id_unique").on(table.merchantId, table.id), index("product_revisions_merchant_idx").on(table.merchantId)]);

export const paymentConfigurations = pgTable("merchant_payment_configurations", {
  id: uuid("id").primaryKey(), merchantId: uuid("merchant_id").notNull().references(() => merchants.id), adapter: text("adapter").notNull(), keyId: text("key_id"),
  keySecretCiphertext: text("key_secret_ciphertext"), webhookSecretCiphertext: text("webhook_secret_ciphertext"), encryptionKeyVersion: integer("encryption_key_version").notNull(), version: integer("version").notNull(), active: boolean("active").notNull().default(true), createdAt: createdAt(),
}, (table) => [uniqueIndex("payment_config_merchant_version_unique").on(table.merchantId, table.version)]);

export const purchasePermits = pgTable("intent_locks", {
  id: uuid("id").primaryKey(), buyerId: uuid("buyer_id").notNull().references(() => users.id), merchantId: uuid("merchant_id").notNull().references(() => merchants.id), productId: uuid("product_id").notNull().references(() => products.id), productRevisionId: uuid("product_revision_id").notNull().references(() => productRevisions.id),
  quantity: integer("quantity").notNull().default(1), currency: text("currency").notNull().default("INR"), productSnapshotHash: text("product_snapshot_hash").notNull(), lockedUnitPricePaise: integer("locked_unit_price_paise").notNull(), maxTotalPaise: integer("max_total_paise").notNull(), priceChangePolicy: text("price_change_policy").notNull(), requireRefundable: boolean("require_refundable").notNull(), minimumRefundWindowDays: integer("minimum_refund_window_days"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }), idempotencyKey: text("idempotency_key").notNull().unique(), approvalTokenHash: text("approval_token_hash").notNull(), approvalTokenExchangedAt: timestamp("approval_token_exchanged_at", { withTimezone: true, mode: "string" }), status: text("status").notNull(), createdAt: createdAt(),
}, (table) => [index("intent_buyer_idx").on(table.buyerId), index("intent_merchant_idx").on(table.merchantId)]);

export const approvalSessions = pgTable("approval_sessions", {
  tokenHash: text("token_hash").primaryKey(), purchasePermitId: uuid("intent_lock_id").notNull().references(() => purchasePermits.id), buyerId: uuid("buyer_id").notNull().references(() => users.id), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }), createdAt: createdAt(),
}, (table) => [index("approval_intent_idx").on(table.purchasePermitId)]);

export const paymentOrders = pgTable("payment_orders", {
  id: uuid("id").primaryKey(), purchasePermitId: uuid("intent_lock_id").notNull().references(() => purchasePermits.id).unique(), merchantId: uuid("merchant_id").notNull().references(() => merchants.id), buyerId: uuid("buyer_id").notNull().references(() => users.id),
  providerOrderId: text("provider_order_id").unique(), amountPaise: integer("amount_paise").notNull(), currency: text("currency").notNull().default("INR"), checkoutTokenHash: text("checkout_token_hash").notNull().unique(), checkoutToken: text("checkout_token").notNull(), status: text("status").notNull(), paymentId: text("payment_id").unique(),
  observedProductVersion: integer("observed_product_version").notNull(), observedProductRevisionId: uuid("observed_product_revision_id").notNull().references(() => productRevisions.id), observedSnapshotHash: text("observed_snapshot_hash").notNull(), observedCatalogSource: text("observed_catalog_source").notNull().default("agentrail_server"), observedShopDomain: text("observed_shop_domain"), observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(), paymentConfigVersion: integer("payment_config_version").notNull(), createdAt: createdAt(),
}, (table) => [index("orders_merchant_idx").on(table.merchantId), index("orders_buyer_idx").on(table.buyerId)]);

export const webhookEvents = pgTable("webhook_events", {
  merchantId: uuid("merchant_id").notNull().references(() => merchants.id), eventId: text("event_id").notNull(), eventType: text("event_type").notNull(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.merchantId, table.eventId] })]);

export const auditChainHeads = pgTable("audit_chain_heads", {
  scopeType: text("scope_type").notNull(), scopeId: uuid("scope_id").notNull(), merchantId: uuid("merchant_id").notNull().references(() => merchants.id), sequence: integer("sequence").notNull().default(0), hash: text("hash").notNull().default("GENESIS"),
}, (table) => [primaryKey({ columns: [table.scopeType, table.scopeId] })]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(), sequence: integer("sequence").notNull(), scopeType: text("scope_type").notNull(), scopeId: uuid("scope_id").notNull(), merchantId: uuid("merchant_id").notNull().references(() => merchants.id), purchasePermitId: uuid("intent_lock_id").references(() => purchasePermits.id),
  eventType: text("event_type").notNull(), actor: text("actor").notNull(), reasonCode: text("reason_code"), payload: jsonb("payload_json").notNull(), previousHash: text("previous_hash").notNull(), hash: text("hash").notNull(), createdAt: createdAt(),
}, (table) => [uniqueIndex("audit_scope_sequence_unique").on(table.scopeType, table.scopeId, table.sequence), uniqueIndex("audit_scope_hash_unique").on(table.scopeType, table.scopeId, table.hash), index("audit_merchant_idx").on(table.merchantId)]);

export const oauthAuthorizationCodes = pgTable("oauth_authorization_codes", {
  codeHash: text("code_hash").primaryKey(), userId: uuid("user_id").notNull().references(() => users.id), clientId: text("client_id").notNull(), redirectUri: text("redirect_uri").notNull(), resource: text("resource").notNull(), scopes: jsonb("scopes_json").notNull(), codeChallenge: text("code_challenge").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }), createdAt: createdAt(),
});

export const oauthTokens = pgTable("oauth_tokens", {
  id: uuid("id").primaryKey(), tokenHash: text("token_hash").notNull().unique(), tokenType: text("token_type").notNull(), familyId: uuid("family_id").notNull(), userId: uuid("user_id").notNull().references(() => users.id), clientId: text("client_id").notNull(), resource: text("resource").notNull(), scopes: jsonb("scopes_json").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }), revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }), replacedById: uuid("replaced_by_id"), createdAt: createdAt(),
}, (table) => [index("oauth_family_idx").on(table.familyId), index("oauth_user_idx").on(table.userId)]);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(), count: integer("count").notNull(), windowEndsAt: timestamp("window_ends_at", { withTimezone: true, mode: "string" }).notNull(), updatedAt: updatedAt(),
});

export const shoppingTasks = pgTable("shopping_tasks", {
  id: uuid("id").primaryKey(), buyerId: uuid("buyer_id").notNull().references(() => users.id), site: text("site").notNull(), query: text("query"), productUrl: text("product_url"),
  maxTotalPaise: integer("max_total_paise").notNull(), requireRefundable: boolean("require_refundable").notNull().default(false), minimumReturnWindowDays: integer("minimum_return_window_days"), latestDeliveryDate: date("latest_delivery_date", { mode: "string" }),
  quantity: integer("quantity").notNull().default(1), currency: text("currency").notNull().default("INR"), status: text("status").notNull(), selectedCandidateId: uuid("selected_candidate_id"), purchasePermitId: uuid("purchase_permit_id"),
  checkoutSnapshotHash: text("checkout_snapshot_hash"), confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }), denialReason: text("denial_reason"), mode: text("mode").notNull().default("prepare_only"), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), createdAt: createdAt(), updatedAt: updatedAt(),
  paymentPreference: text("payment_preference"),
}, (table) => [index("shopping_tasks_buyer_status_idx").on(table.buyerId, table.status, table.createdAt)]);

export const shoppingCandidates = pgTable("shopping_candidates", {
  id: uuid("id").primaryKey(), taskId: uuid("task_id").notNull().references(() => shoppingTasks.id), canonicalProductId: text("canonical_product_id").notNull(), listingId: text("listing_id"), title: text("title").notNull(), seller: text("seller"), variant: text("variant"), condition: text("condition").notNull(), availability: text("availability").notNull(), pricePaise: integer("price_paise").notNull(), currency: text("currency").notNull(), productUrl: text("product_url").notNull(), snapshotHash: text("snapshot_hash").notNull(), observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(), adapterId: text("adapter_id").notNull(), adapterVersion: text("adapter_version").notNull(), selected: boolean("selected").notNull().default(false), createdAt: createdAt(),
}, (table) => [uniqueIndex("shopping_candidates_task_product_idx").on(table.taskId, table.canonicalProductId, table.productUrl)]);

export const browserPurchasePermits = pgTable("browser_purchase_permits", {
  id: uuid("id").primaryKey(), taskId: uuid("task_id").notNull().references(() => shoppingTasks.id).unique(), buyerId: uuid("buyer_id").notNull().references(() => users.id), checkoutSnapshot: jsonb("checkout_snapshot_json").notNull(), checkoutSnapshotHash: text("checkout_snapshot_hash").notNull(), maxTotalPaise: integer("max_total_paise").notNull(), status: text("status").notNull(), confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), idempotencyKey: text("idempotency_key").notNull().unique(), createdAt: createdAt(),
});

export const browserInstallations = pgTable("browser_installations", {
  id: uuid("id").primaryKey(), buyerId: uuid("buyer_id").notNull().references(() => users.id), oauthClientId: text("oauth_client_id").notNull(), name: text("name").notNull(), lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(), revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }), createdAt: createdAt(),
}, (table) => [index("browser_installations_buyer_idx").on(table.buyerId, table.revokedAt)]);

export const browserObservations = pgTable("browser_observations", {
  id: uuid("id").primaryKey(), taskId: uuid("task_id").notNull().references(() => shoppingTasks.id), installationId: uuid("installation_id").notNull().references(() => browserInstallations.id), kind: text("kind").notNull(), adapterId: text("adapter_id").notNull(), adapterVersion: text("adapter_version").notNull(), sourceUrl: text("source_url").notNull(), snapshot: jsonb("snapshot_json").notNull(), snapshotHash: text("snapshot_hash").notNull(), observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(), createdAt: createdAt(),
}, (table) => [index("browser_observations_task_idx").on(table.taskId, table.createdAt)]);

export const browserExecutionAttempts = pgTable("browser_execution_attempts", {
  id: uuid("id").primaryKey(), taskId: uuid("task_id").notNull().references(() => shoppingTasks.id).unique(), installationId: uuid("installation_id").notNull().references(() => browserInstallations.id), grantTokenHash: text("grant_token_hash").unique(), grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true, mode: "string" }), status: text("status").notNull(), outcome: jsonb("outcome_json"), createdAt: createdAt(), updatedAt: updatedAt(),
});

export const browserApprovalContinuations = pgTable("browser_approval_continuations", {
  id: uuid("id").primaryKey(), taskId: uuid("task_id").notNull().references(() => shoppingTasks.id), installationId: uuid("installation_id").notNull().references(() => browserInstallations.id),
  redirectUri: text("redirect_uri").notNull(), state: text("state").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }), createdAt: createdAt(),
}, (table) => [index("browser_approval_continuations_task_idx").on(table.taskId, table.expiresAt)]);

export const shoppingAuditChainHeads = pgTable("shopping_audit_chain_heads", {
  taskId: uuid("task_id").primaryKey().references(() => shoppingTasks.id), sequence: integer("sequence").notNull().default(0), hash: text("hash").notNull().default("GENESIS"),
});
export const shoppingAuditEvents = pgTable("shopping_audit_events", {
  id: uuid("id").primaryKey(), taskId: uuid("task_id").notNull().references(() => shoppingTasks.id), buyerId: uuid("buyer_id").notNull().references(() => users.id), sequence: integer("sequence").notNull(), eventType: text("event_type").notNull(), actor: text("actor").notNull(), reasonCode: text("reason_code"), adapterId: text("adapter_id"), adapterVersion: text("adapter_version"), evidenceAssurance: text("evidence_assurance").notNull().default("browser_observed"), payload: jsonb("payload_json").notNull(), previousHash: text("previous_hash").notNull(), hash: text("hash").notNull(), createdAt: createdAt(),
}, (table) => [uniqueIndex("shopping_audit_task_sequence_unique").on(table.taskId, table.sequence), uniqueIndex("shopping_audit_task_hash_unique").on(table.taskId, table.hash)]);
