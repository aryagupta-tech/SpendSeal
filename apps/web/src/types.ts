import type { AuditEvent, PurchasePermit, Merchant, PaymentOrder, Product, User } from "@spendseal/core";

export type Session = { user: User; csrfToken: string };
export type MerchantList = { merchants: Merchant[]; nextCursor: string | null };
export type ProductList = { products: Product[]; nextCursor: string | null };
export type IntentResponse = { intent: PurchasePermit; product: Product; approvalUrl?: string };
export type CheckoutDetails = { order: PaymentOrder; intent: PurchasePermit; product: Product; merchant: Merchant; keyId: string; adapter: "mock" | "razorpay" };
export type AuditData = { events: AuditEvent[]; verification: { valid: boolean; checked: number; brokenAt: number | null } };
