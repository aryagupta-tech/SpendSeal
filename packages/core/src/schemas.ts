import { z } from "zod";

export const PRICE_CHANGE_POLICIES = ["none", "decrease_only", "within_cap"] as const;
export const INTENT_STATUSES = ["pending_confirmation", "confirmed", "executing", "checkout_ready", "paid", "denied", "expired", "reconciliation_required"] as const;
export const MERCHANT_ROLES = ["owner", "admin", "catalog_manager", "auditor"] as const;
export const API_KEY_SCOPES = ["catalog:read", "catalog:write", "orders:read", "audit:read"] as const;
export const MCP_SCOPES = ["catalog:read", "intents:create", "intents:read", "checkout:prepare", "audit:read"] as const;

export const PriceChangePolicySchema = z.enum(PRICE_CHANGE_POLICIES);
export type PriceChangePolicy = z.infer<typeof PriceChangePolicySchema>;

export const UserSchema = z.object({ id: z.string().uuid(), username: z.string().min(3), displayName: z.string().min(1), status: z.enum(["active", "disabled"]), createdAt: z.string().datetime() });
export type User = z.infer<typeof UserSchema>;

export const MerchantSchema = z.object({ id: z.string().uuid(), slug: z.string().min(2), displayName: z.string().min(1), status: z.enum(["active", "suspended"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type Merchant = z.infer<typeof MerchantSchema>;

export const CatalogAuthoritySchema = z.object({ type: z.literal("merchant_managed_catalog"), merchantId: z.string().uuid(), source: z.literal("agentrail_server") });
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

export const IntentLockSchema = z.object({
  id: z.string().uuid(), buyerId: z.string().uuid(), merchantId: z.string().uuid(), productId: z.string().uuid(), productRevisionId: z.string().uuid(),
  quantity: z.literal(1), currency: z.literal("INR"), productSnapshotHash: z.string(), lockedUnitPricePaise: z.number().int().positive(),
  maxTotalPaise: z.number().int().positive(), priceChangePolicy: PriceChangePolicySchema, requireRefundable: z.boolean(),
  minimumRefundWindowDays: z.number().int().nonnegative().nullable(), expiresAt: z.string().datetime(), confirmationRequired: z.literal(true),
  confirmedAt: z.string().datetime().nullable(), idempotencyKey: z.string(), status: z.enum(INTENT_STATUSES), createdAt: z.string().datetime(),
});
export type IntentLock = z.infer<typeof IntentLockSchema>;

export const REASON_CODES = [
  "ALLOWED", "MERCHANT_MISMATCH", "PRODUCT_MISMATCH", "PRODUCT_INACTIVE", "CURRENCY_MISMATCH", "PRICE_CHANGED", "BUDGET_EXCEEDED",
  "NOT_REFUNDABLE", "REFUND_POLICY_CHANGED", "EXPIRED", "CONFIRMATION_REQUIRED", "REPLAY_DETECTED", "PAYMENT_SIGNATURE_INVALID",
  "PAYMENT_PROVIDER_UNCERTAIN", "AUTH_REQUIRED", "TENANT_ACCESS_DENIED", "PRODUCT_VERSION_CONFLICT", "PAYMENT_CONFIG_MISSING",
] as const;
export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(), reasons: z.array(ReasonCodeSchema), message: z.string(), evaluatedAt: z.string().datetime(), observedAt: z.string().datetime(),
  observedPricePaise: z.number().int().nonnegative(), observedProductVersion: z.number().int().positive().nullable(),
  observedProductRevisionId: z.string().uuid().nullable(), observedProductSnapshotHash: z.string().nullable(), catalogAuthority: CatalogAuthoritySchema.nullable(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const AuditActorSchema = z.enum(["chatgpt", "buyer", "merchant", "policy_engine", "razorpay", "system"]);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditEventSchema = z.object({
  id: z.string().uuid(), sequence: z.number().int().positive(), scopeType: z.enum(["intent", "merchant"]), scopeId: z.string().uuid(),
  merchantId: z.string().uuid(), intentLockId: z.string().uuid().nullable(), eventType: z.string(), actor: AuditActorSchema,
  reasonCode: ReasonCodeSchema.nullable(), payload: z.unknown(), previousHash: z.string(), hash: z.string(), createdAt: z.string().datetime(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const PaymentOrderSchema = z.object({
  id: z.string().uuid(), intentLockId: z.string().uuid(), merchantId: z.string().uuid(), buyerId: z.string().uuid(), providerOrderId: z.string(),
  amountPaise: z.number().int().positive(), currency: z.literal("INR"), checkoutToken: z.string(), status: z.enum(["creating", "ready", "paid", "reconciliation_required"]),
  paymentId: z.string().nullable(), createdAt: z.string().datetime(), observedProductVersion: z.number().int().positive(), observedProductRevisionId: z.string().uuid(),
  observedProductSnapshotHash: z.string(), catalogAuthority: CatalogAuthoritySchema, observedAt: z.string().datetime(), paymentConfigVersion: z.number().int().nonnegative(),
});
export type PaymentOrder = z.infer<typeof PaymentOrderSchema>;
