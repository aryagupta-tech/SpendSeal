import type { AuditEvent, BrowserPurchasePermit, MerchantAiSalesSummary, MerchantReadiness, ProductSelectionProposal, PurchasePermit, Merchant, PaymentOrder, Product, ShoppingCandidate, ShoppingTask, User } from "@spendseal/core";

export type Session = { user: User; csrfToken: string };
export type MerchantList = { merchants: Merchant[]; nextCursor: string | null };
export type ProductList = { products: Product[]; nextCursor: string | null };
export type IntentResponse = { intent: PurchasePermit; product: Product; approvalUrl?: string };
export type CheckoutDetails = { order: PaymentOrder; intent: PurchasePermit; product: Product; merchant: Merchant; keyId: string; adapter: "mock" | "razorpay" };
export type AuditData = { events: AuditEvent[]; verification: { valid: boolean; checked: number; brokenAt: number | null } };
export type ShoppingTaskResponse = { task: ShoppingTask; candidates: ShoppingCandidate[]; permit: BrowserPurchasePermit | null; proposal: ProductSelectionProposal | null };
export type AiSalesChannel = { readiness: MerchantReadiness; summary: MerchantAiSalesSummary };
