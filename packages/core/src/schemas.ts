import { z } from "zod";

export const PRICE_CHANGE_POLICIES = ["none", "decrease_only", "within_cap"] as const;
export const INTENT_STATUSES = ["pending_confirmation", "confirmed", "executing", "checkout_ready", "paid", "denied", "expired", "reconciliation_required"] as const;
export const MERCHANT_ROLES = ["owner", "admin", "catalog_manager", "auditor"] as const;
export const API_KEY_SCOPES = ["catalog:read", "catalog:write", "orders:read", "audit:read"] as const;
export const MCP_SCOPES = ["catalog:read", "intents:create", "intents:read", "checkout:prepare", "audit:read", "shopping:create", "shopping:read", "shopping:audit"] as const;
export const BROWSER_SCOPES = ["browser:tasks:read", "browser:observations:write", "browser:execute"] as const;
export const SHOPPING_SITES = ["amazon_in", "flipkart_in"] as const;
export const SHOPPING_TASK_STATUSES = [
  "created", "waiting_for_extension", "searching", "selection_required", "navigating", "checkout_observed", "pending_approval",
  "checkout_configuring", "payment_choice_required", "payment_action_required",
  "approved", "policy_check", "prepared", "submitting", "completed", "user_action_required", "denied", "reconciliation_required", "failed", "expired",
] as const;

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
export const PaymentPreferenceSchema = z.enum(["cash_on_delivery", "online"]);
export type PaymentPreference = z.infer<typeof PaymentPreferenceSchema>;
export const ShoppingTaskStatusSchema = z.enum(SHOPPING_TASK_STATUSES);
export type ShoppingTaskStatus = z.infer<typeof ShoppingTaskStatusSchema>;

export const CreateShoppingTaskInputSchema = z.object({
  site: ShoppingSiteSchema,
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

export const ShoppingCandidateSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), canonicalProductId: z.string().min(1), listingId: z.string().nullable(), title: z.string().min(1),
  seller: z.string().nullable(), variant: z.string().nullable(), condition: z.string().default("new"), availability: z.string(), pricePaise: z.number().int().positive(),
  currency: z.literal("INR"), productUrl: z.string().url(), snapshotHash: z.string(), observedAt: z.string().datetime(), adapterId: ShoppingSiteSchema,
  adapterVersion: z.string(), selected: z.boolean(),
});
export type ShoppingCandidate = z.infer<typeof ShoppingCandidateSchema>;

export const CheckoutObservationSchema = z.object({
  site: ShoppingSiteSchema, sourceUrl: z.string().url(), canonicalProductId: z.string().min(1), listingId: z.string().nullable(), title: z.string().min(1),
  seller: z.string().nullable(), variant: z.string().nullable(), condition: z.string().min(1), quantity: z.number().int().positive(), currency: z.literal("INR"),
  itemSubtotalPaise: z.number().int().nonnegative(), shippingPaise: z.number().int().nonnegative(), taxPaise: z.number().int().nonnegative(),
  discountPaise: z.number().int().nonnegative(), finalTotalPaise: z.number().int().positive(), extraCartItemCount: z.number().int().nonnegative(),
  refundable: z.boolean().nullable(), returnWindowDays: z.number().int().nonnegative().nullable(), deliveryDate: z.string().date().nullable(),
  maskedAddressLabel: z.string().max(80).nullable(), addressFingerprint: z.string().max(128).nullable(), paymentMethodType: z.string().max(40).nullable(),
  paymentPreference: PaymentPreferenceSchema,
  observedAt: z.string().datetime(), adapterId: ShoppingSiteSchema, adapterVersion: z.string().min(1), evidenceAssurance: z.literal("browser_observed"),
});
export type CheckoutObservation = z.infer<typeof CheckoutObservationSchema>;

export const ShoppingTaskSchema = z.object({
  id: z.string().uuid(), buyerId: z.string().uuid(), site: ShoppingSiteSchema, query: z.string().nullable(), productUrl: z.string().url().nullable(),
  maxTotalPaise: z.number().int().positive(), requireRefundable: z.boolean(), minimumReturnWindowDays: z.number().int().nonnegative().nullable(),
  latestDeliveryDate: z.string().date().nullable(), quantity: z.literal(1), currency: z.literal("INR"), status: ShoppingTaskStatusSchema,
  paymentPreference: PaymentPreferenceSchema.nullable(),
  selectedCandidateId: z.string().uuid().nullable(), purchasePermitId: z.string().uuid().nullable(), checkoutSnapshotHash: z.string().nullable(),
  confirmedAt: z.string().datetime().nullable(), denialReason: ReasonCodeSchema.nullable(), mode: z.enum(["prepare_only", "live"]),
  expiresAt: z.string().datetime(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type ShoppingTask = z.infer<typeof ShoppingTaskSchema>;

export const BrowserPurchasePermitSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), buyerId: z.string().uuid(), checkoutSnapshot: CheckoutObservationSchema,
  checkoutSnapshotHash: z.string(), maxTotalPaise: z.number().int().positive(), status: z.enum(["pending_confirmation", "confirmed", "prepared", "submitting", "completed", "denied", "reconciliation_required"]),
  confirmedAt: z.string().datetime().nullable(), expiresAt: z.string().datetime(), idempotencyKey: z.string(), createdAt: z.string().datetime(),
});
export type BrowserPurchasePermit = z.infer<typeof BrowserPurchasePermitSchema>;
