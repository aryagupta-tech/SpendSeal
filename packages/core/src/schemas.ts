import { z } from "zod";

export const PRICE_CHANGE_POLICIES = ["none", "decrease_only", "within_cap"] as const;
export const INTENT_STATUSES = ["pending_confirmation", "confirmed", "executing", "checkout_ready", "paid", "denied", "expired", "reconciliation_required"] as const;
export const MERCHANT_ROLES = ["owner", "admin", "catalog_manager", "auditor"] as const;
export const API_KEY_SCOPES = ["catalog:read", "catalog:write", "orders:read", "audit:read"] as const;
export const MCP_SCOPES = ["catalog:read", "intents:create", "intents:read", "checkout:prepare", "audit:read", "shopping:create", "shopping:read", "shopping:audit"] as const;
export const BROWSER_SCOPES = ["browser:tasks:read", "browser:observations:write", "browser:execute"] as const;
export const SHOPPING_SITES = ["amazon_in", "flipkart_in", "openai_api", "generic_web"] as const;
export const SHOPPING_TASK_STATUSES = [
  "created", "waiting_for_extension", "searching", "selection_required", "product_review_required", "selection_confirmed", "operator_navigating", "navigating", "checkout_observed", "pending_approval",
  "checkout_configuring", "payment_choice_required", "payment_action_required",
  "approved", "policy_check", "prepared", "submitting", "completed", "user_action_required", "denied", "reconciliation_required", "failed", "expired",
] as const;
export const MERCHANT_READINESS_STATUSES = ["not_ready", "catalog_ready", "ai_transactable", "payment_verified"] as const;
export const AI_COMMERCE_EVENT_TYPES = [
  "CATALOG_DISCOVERED", "PRODUCTS_PRESENTED", "PURCHASE_PERMIT_CREATED", "PASSKEY_APPROVED", "POLICY_ALLOWED", "POLICY_DENIED",
  "PAYMENT_ORDER_CREATED", "PAYMENT_VERIFIED", "REPLAY_BLOCKED",
] as const;
export const AI_COMMERCE_SOURCES = ["chatgpt_mcp", "buyer_web", "policy_engine", "razorpay", "mock_adapter", "system"] as const;

export const PriceChangePolicySchema = z.enum(PRICE_CHANGE_POLICIES);
export type PriceChangePolicy = z.infer<typeof PriceChangePolicySchema>;

export const UserSchema = z.object({ id: z.string().uuid(), username: z.string().min(3), displayName: z.string().min(1), status: z.enum(["active", "disabled"]), createdAt: z.string().datetime() });
export type User = z.infer<typeof UserSchema>;

export const MerchantSchema = z.object({ id: z.string().uuid(), slug: z.string().min(2), displayName: z.string().min(1), status: z.enum(["active", "suspended"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type Merchant = z.infer<typeof MerchantSchema>;

export const CatalogAuthoritySchema = z.object({
  type: z.literal("merchant_managed_catalog"),
  merchantId: z.string().uuid(),
  source: z.enum(["spendseal_server", "shopify_admin_graphql"]),
  shopDomain: z.string().nullable().optional(),
});
export type CatalogAuthority = z.infer<typeof CatalogAuthoritySchema>;

export const ProductSchema = z.object({
  id: z.string().uuid(), merchantId: z.string().uuid(), sku: z.string().min(1), name: z.string().min(1), description: z.string(),
  pricePaise: z.number().int().positive(), currency: z.literal("INR"), refundable: z.boolean(), refundWindowDays: z.number().int().nonnegative(),
  active: z.boolean(), version: z.number().int().positive(), revisionId: z.string().uuid(), snapshotHash: z.string(), catalogAuthority: CatalogAuthoritySchema,
  refundTermsAuthority: z.literal("merchant_stated"), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

export const MerchantReadinessStatusSchema = z.enum(MERCHANT_READINESS_STATUSES);
export type MerchantReadinessStatus = z.infer<typeof MerchantReadinessStatusSchema>;

export const MerchantReadinessSchema = z.object({
  status: MerchantReadinessStatusSchema,
  merchantId: z.string().uuid(), merchantSlug: z.string(), merchantName: z.string(),
  shopifyConnected: z.boolean(), razorpayTestModeConnected: z.boolean(), productsAvailable: z.number().int().nonnegative(),
  chatGptConnectionAvailable: z.literal(true), webhookStatus: z.enum(["not_configured", "configured_unverified", "verified"]),
  samplePrompt: z.string(), evidenceAssurance: z.enum(["merchant_managed", "provider_verified"]),
});
export type MerchantReadiness = z.infer<typeof MerchantReadinessSchema>;

export const MerchantStorefrontSchema = z.object({
  merchant: MerchantSchema.pick({ id: true, slug: true, displayName: true, status: true }),
  products: z.array(ProductSchema), supportedCurrency: z.literal("INR"), refundTermsAuthority: z.literal("merchant_stated"),
  checkout: z.object({ purchasePermitAvailable: z.boolean(), buyerPasskeyRequired: z.literal(true), razorpayTestModeAvailable: z.boolean(), evidenceAssurance: z.enum(["merchant_managed", "provider_verified"]), livePaymentMode: z.literal("test") }),
  readiness: MerchantReadinessSchema,
});
export type MerchantStorefront = z.infer<typeof MerchantStorefrontSchema>;

export const MerchantAiSalesSummarySchema = z.object({
  catalogDiscoveries: z.number().int().nonnegative(), productsShown: z.number().int().nonnegative(), purchasePermitsCreated: z.number().int().nonnegative(),
  passkeyApprovals: z.number().int().nonnegative(), policyAllowedCheckouts: z.number().int().nonnegative(), policyDenials: z.number().int().nonnegative(),
  razorpayTestOrdersCreated: z.number().int().nonnegative(), razorpayTestPaymentsVerified: z.number().int().nonnegative(), testGmvPaise: z.number().int().nonnegative(),
  safelyStoppedPurchases: z.number().int().nonnegative(), permitToApprovalRate: z.number().min(0).max(100), approvalToPaymentRate: z.number().min(0).max(100),
  topProducts: z.array(z.object({ productId: z.string().uuid(), name: z.string(), selections: z.number().int().positive() })),
});
export type MerchantAiSalesSummary = z.infer<typeof MerchantAiSalesSummarySchema>;

export const AiCommerceEventTypeSchema = z.enum(AI_COMMERCE_EVENT_TYPES);
export type AiCommerceEventType = z.infer<typeof AiCommerceEventTypeSchema>;
export const AiCommerceSourceSchema = z.enum(AI_COMMERCE_SOURCES);
export type AiCommerceSource = z.infer<typeof AiCommerceSourceSchema>;

export const CreateIntentInputSchema = z.object({
  merchantId: z.string().uuid(), productId: z.string().uuid(), maxTotalPaise: z.number().int().positive().optional(),
  priceChangePolicy: PriceChangePolicySchema.default("none"), requireRefundable: z.boolean().default(false),
  minimumRefundWindowDays: z.number().int().min(0).max(90).nullable().default(null), expiresInMinutes: z.number().int().min(1).max(30).default(10),
});
export type CreateIntentInput = z.infer<typeof CreateIntentInputSchema>;

export const PurchasePermitSchema = z.object({
  id: z.string().uuid(), buyerId: z.string().uuid(), merchantId: z.string().uuid(), productId: z.string().uuid(), productRevisionId: z.string().uuid(),
  quantity: z.literal(1), currency: z.literal("INR"), productSnapshotHash: z.string(), lockedUnitPricePaise: z.number().int().positive(),
  maxTotalPaise: z.number().int().positive(), priceChangePolicy: PriceChangePolicySchema, requireRefundable: z.boolean(),
  minimumRefundWindowDays: z.number().int().nonnegative().nullable(), expiresAt: z.string().datetime(), confirmationRequired: z.literal(true),
  confirmedAt: z.string().datetime().nullable(), idempotencyKey: z.string(), status: z.enum(INTENT_STATUSES), createdAt: z.string().datetime(),
});
export type PurchasePermit = z.infer<typeof PurchasePermitSchema>;

export const REASON_CODES = [
  "ALLOWED", "MERCHANT_MISMATCH", "PRODUCT_MISMATCH", "PRODUCT_INACTIVE", "CURRENCY_MISMATCH", "PRICE_CHANGED", "BUDGET_EXCEEDED",
  "NOT_REFUNDABLE", "REFUND_POLICY_CHANGED", "EXPIRED", "CONFIRMATION_REQUIRED", "REPLAY_DETECTED", "PAYMENT_SIGNATURE_INVALID",
  "PAYMENT_PROVIDER_UNCERTAIN", "AUTH_REQUIRED", "TENANT_ACCESS_DENIED", "PRODUCT_VERSION_CONFLICT", "PAYMENT_CONFIG_MISSING",
  "CATALOG_REFRESH_FAILED", "SITE_NOT_SUPPORTED", "DOMAIN_MISMATCH", "CHECKOUT_UNVERIFIABLE", "PRODUCT_CHANGED", "VARIANT_CHANGED",
  "SELLER_CHANGED", "QUANTITY_CHANGED", "TOTAL_CHANGED", "UNEXPECTED_CART_ITEMS", "USER_ACTION_REQUIRED", "AUTOMATION_BLOCKED",
  "LIVE_PURCHASE_DISABLED", "ADDRESS_CHANGED", "DELIVERY_CHANGED", "PAYMENT_METHOD_CHANGED", "PAYMENT_OPTION_UNAVAILABLE",
  "PRODUCT_REVIEW_REQUIRED", "SITE_PERMISSION_REQUIRED", "SENSITIVE_FIELD_BLOCKED", "RECURRING_BILLING_DETECTED",
  "FINAL_ACTION_UNVERIFIABLE", "FX_QUOTE_UNAVAILABLE", "ACCOUNT_CHANGED",
] as const;
export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(), reasons: z.array(ReasonCodeSchema), message: z.string(), evaluatedAt: z.string().datetime(), observedAt: z.string().datetime(),
  observedPricePaise: z.number().int().nonnegative(), observedProductVersion: z.number().int().positive().nullable(),
  observedProductRevisionId: z.string().uuid().nullable(), observedProductSnapshotHash: z.string().nullable(), catalogAuthority: CatalogAuthoritySchema.nullable(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const AuditActorSchema = z.enum(["chatgpt", "buyer", "merchant", "policy_engine", "mock_adapter", "razorpay", "system"]);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditEventSchema = z.object({
  id: z.string().uuid(), sequence: z.number().int().positive(), scopeType: z.enum(["intent", "merchant"]), scopeId: z.string().uuid(),
  merchantId: z.string().uuid(), purchasePermitId: z.string().uuid().nullable(), eventType: z.string(), actor: AuditActorSchema,
  reasonCode: ReasonCodeSchema.nullable(), payload: z.unknown(), previousHash: z.string(), hash: z.string(), createdAt: z.string().datetime(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const PaymentOrderSchema = z.object({
  id: z.string().uuid(), purchasePermitId: z.string().uuid(), merchantId: z.string().uuid(), buyerId: z.string().uuid(), providerOrderId: z.string(),
  amountPaise: z.number().int().positive(), currency: z.literal("INR"), checkoutToken: z.string(), status: z.enum(["creating", "ready", "paid", "reconciliation_required"]),
  paymentId: z.string().nullable(), createdAt: z.string().datetime(), observedProductVersion: z.number().int().positive(), observedProductRevisionId: z.string().uuid(),
  observedProductSnapshotHash: z.string(), catalogAuthority: CatalogAuthoritySchema, observedAt: z.string().datetime(), paymentConfigVersion: z.number().int().nonnegative(),
});
export type PaymentOrder = z.infer<typeof PaymentOrderSchema>;

export const ShoppingSiteSchema = z.enum(SHOPPING_SITES);
export type ShoppingSite = z.infer<typeof ShoppingSiteSchema>;
export const EvidenceAssuranceSchema = z.enum(["provider_verified", "browser_observed", "agent_assisted", "prepared_only"]);
export type EvidenceAssurance = z.infer<typeof EvidenceAssuranceSchema>;
export const PurchaseKindSchema = z.enum(["physical_good", "api_credits", "generic_one_time"]);
export type PurchaseKind = z.infer<typeof PurchaseKindSchema>;
export const PaymentPreferenceSchema = z.enum(["cash_on_delivery", "online"]);
export type PaymentPreference = z.infer<typeof PaymentPreferenceSchema>;
export const ShoppingTaskStatusSchema = z.enum(SHOPPING_TASK_STATUSES);
export type ShoppingTaskStatus = z.infer<typeof ShoppingTaskStatusSchema>;

export const CreateShoppingTaskInputSchema = z.object({
  site: z.enum(["amazon_in", "flipkart_in"]),
  query: z.string().trim().min(2).max(240).optional(),
  productUrl: z.string().url().max(2048).optional(),
  maxTotalPaise: z.number().int().positive().max(100_000_000),
  requireRefundable: z.boolean().default(false),
  minimumReturnWindowDays: z.number().int().min(0).max(90).nullable().default(null),
  latestDeliveryDate: z.string().date().nullable().default(null),
  expiresInMinutes: z.number().int().min(1).max(30).default(10),
}).superRefine((value, context) => {
  if (Boolean(value.query) === Boolean(value.productUrl)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one of query or productUrl." });
  if (value.productUrl) {
    const host = new URL(value.productUrl).hostname.toLowerCase();
    const allowed = value.site === "amazon_in" ? ["amazon.in", "www.amazon.in"] : ["flipkart.com", "www.flipkart.com"];
    if (!allowed.includes(host)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Product URL does not match the selected supported site.", path: ["productUrl"] });
  }
});
export type CreateShoppingTaskInput = z.infer<typeof CreateShoppingTaskInputSchema>;

export const CreateWebPurchaseTaskInputSchema = z.object({
  siteUrl: z.string().url().max(2048).refine((value) => new URL(value).protocol === "https:", "Only HTTPS websites are supported."),
  objective: z.string().trim().min(2).max(500),
  maxTotalPaise: z.number().int().positive().max(100_000_000),
  purchaseKind: PurchaseKindSchema.default("generic_one_time"),
  requireRefundable: z.boolean().default(false),
  minimumReturnWindowDays: z.number().int().min(0).max(90).nullable().default(null),
  latestDeliveryDate: z.string().date().nullable().default(null),
  expiresInMinutes: z.number().int().min(1).max(30).default(15),
}).transform((value) => {
  const url = new URL(value.siteUrl); const host = url.hostname.toLowerCase();
  const site = host === "amazon.in" || host === "www.amazon.in" ? "amazon_in"
    : host === "flipkart.com" || host === "www.flipkart.com" ? "flipkart_in"
      : host === "platform.openai.com" ? "openai_api" : "generic_web";
  const purchaseKind = site === "openai_api" ? "api_credits" : site === "amazon_in" || site === "flipkart_in" ? "physical_good" : "generic_one_time";
  return { ...value, site, purchaseKind, allowedOrigin: url.origin };
});
export type CreateWebPurchaseTaskInput = z.infer<typeof CreateWebPurchaseTaskInputSchema>;

export const ShoppingCandidateSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), canonicalProductId: z.string().min(1), listingId: z.string().nullable(), title: z.string().min(1),
  seller: z.string().nullable(), variant: z.string().nullable(), condition: z.string().default("new"), availability: z.string(), pricePaise: z.number().int().positive(),
  currency: z.literal("INR"), productUrl: z.string().url(), snapshotHash: z.string(), observedAt: z.string().datetime(), adapterId: ShoppingSiteSchema,
  adapterVersion: z.string(), selected: z.boolean(), imageUrl: z.string().url().nullable().default(null),
  rating: z.number().min(0).max(5).nullable().default(null), reviewCount: z.number().int().nonnegative().nullable().default(null),
  deliveryEstimate: z.string().max(160).nullable().default(null), rankingReasons: z.array(z.string().max(160)).max(6).default([]),
  proposalSource: z.enum(["recommended", "manual", "agent"]).default("recommended"), queryMismatch: z.boolean().default(false),
});
export type ShoppingCandidate = z.infer<typeof ShoppingCandidateSchema>;

export const ProductSelectionProposalSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), candidateId: z.string().uuid(), source: z.enum(["recommended", "manual", "agent"]),
  status: z.enum(["pending", "confirmed", "replaced", "dismissed", "expired"]), queryMismatch: z.boolean(),
  warning: z.string().max(240).nullable(), expiresAt: z.string().datetime(), confirmedAt: z.string().datetime().nullable(), createdAt: z.string().datetime(),
});
export type ProductSelectionProposal = z.infer<typeof ProductSelectionProposalSchema>;

export const CheckoutObservationSchema = z.object({
  site: ShoppingSiteSchema, sourceUrl: z.string().url(), canonicalProductId: z.string().min(1), listingId: z.string().nullable(), title: z.string().min(1),
  seller: z.string().nullable(), variant: z.string().nullable(), condition: z.string().min(1), quantity: z.number().int().positive(), currency: z.literal("INR"),
  itemSubtotalPaise: z.number().int().nonnegative(), shippingPaise: z.number().int().nonnegative(), taxPaise: z.number().int().nonnegative(),
  discountPaise: z.number().int().nonnegative(), finalTotalPaise: z.number().int().positive(), extraCartItemCount: z.number().int().nonnegative(),
  refundable: z.boolean().nullable(), returnWindowDays: z.number().int().nonnegative().nullable(), deliveryDate: z.string().date().nullable(),
  maskedAddressLabel: z.string().max(80).nullable(), addressFingerprint: z.string().max(128).nullable(), paymentMethodType: z.string().max(40).nullable(),
  paymentPreference: PaymentPreferenceSchema,
  observedAt: z.string().datetime(), adapterId: ShoppingSiteSchema, adapterVersion: z.string().min(1), evidenceAssurance: EvidenceAssuranceSchema,
  accountFingerprint: z.string().max(128).nullable().default(null), maskedAccountLabel: z.string().max(80).nullable().default(null),
  recurring: z.boolean().default(false), finalActionLabel: z.string().max(120).nullable().default(null),
  providerCurrency: z.string().length(3).nullable().default(null), providerAmountMinor: z.number().int().positive().nullable().default(null),
  fxQuote: z.object({ base: z.literal("USD"), quote: z.literal("INR"), rate: z.number().positive(), bufferPercent: z.literal(10), source: z.string().min(1), quotedAt: z.string().datetime() }).nullable().default(null),
});
export type CheckoutObservation = z.infer<typeof CheckoutObservationSchema>;

export const ShoppingTaskSchema = z.object({
  id: z.string().uuid(), buyerId: z.string().uuid(), site: ShoppingSiteSchema, query: z.string().nullable(), productUrl: z.string().url().nullable(),
  maxTotalPaise: z.number().int().positive(), requireRefundable: z.boolean(), minimumReturnWindowDays: z.number().int().nonnegative().nullable(),
  latestDeliveryDate: z.string().date().nullable(), quantity: z.literal(1), currency: z.literal("INR"), status: ShoppingTaskStatusSchema,
  paymentPreference: PaymentPreferenceSchema.nullable(),
  allowedOrigin: z.string().url().nullable().default(null), purchaseKind: PurchaseKindSchema.default("physical_good"),
  proposedCandidateId: z.string().uuid().nullable().default(null), selectionConfirmedAt: z.string().datetime().nullable().default(null),
  selectedCandidateId: z.string().uuid().nullable(), purchasePermitId: z.string().uuid().nullable(), checkoutSnapshotHash: z.string().nullable(),
  confirmedAt: z.string().datetime().nullable(), denialReason: ReasonCodeSchema.nullable(), mode: z.enum(["prepare_only", "live"]),
  expiresAt: z.string().datetime(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type ShoppingTask = z.infer<typeof ShoppingTaskSchema>;

export const RedactedPageSnapshotSchema = z.object({
  url: z.string().url(), title: z.string().max(240), site: ShoppingSiteSchema, capturedAt: z.string().datetime(),
  text: z.array(z.string().max(240)).max(120), controls: z.array(z.object({ ref: z.string().max(80), role: z.string().max(40), label: z.string().max(160), disabled: z.boolean() })).max(120),
  prices: z.array(z.object({ label: z.string().max(120), amount: z.string().max(80) })).max(30),
  sensitiveContentRemoved: z.literal(true), screenshotIncluded: z.literal(false),
});
export type RedactedPageSnapshot = z.infer<typeof RedactedPageSnapshotSchema>;

export const BrowserOperatorActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url().max(2048) }),
  z.object({ type: z.literal("click"), ref: z.string().min(1).max(80) }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]), amount: z.number().int().min(100).max(2000).default(700) }),
  z.object({ type: z.literal("type"), ref: z.string().min(1).max(80), value: z.string().max(500), sensitive: z.literal(false) }),
  z.object({ type: z.literal("select"), ref: z.string().min(1).max(80), value: z.string().max(160) }),
  z.object({ type: z.literal("wait"), milliseconds: z.number().int().min(250).max(5000) }),
]);
export type BrowserOperatorAction = z.infer<typeof BrowserOperatorActionSchema>;

export const BrowserPurchasePermitSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), buyerId: z.string().uuid(), checkoutSnapshot: CheckoutObservationSchema,
  checkoutSnapshotHash: z.string(), maxTotalPaise: z.number().int().positive(), status: z.enum(["pending_confirmation", "confirmed", "prepared", "submitting", "completed", "denied", "reconciliation_required"]),
  confirmedAt: z.string().datetime().nullable(), expiresAt: z.string().datetime(), idempotencyKey: z.string(), createdAt: z.string().datetime(),
});
export type BrowserPurchasePermit = z.infer<typeof BrowserPurchasePermitSchema>;
