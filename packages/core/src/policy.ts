import type { PurchasePermit, PolicyDecision, Product, ReasonCode } from "./schemas.js";

const replayStatuses = new Set<PurchasePermit["status"]>([
  "executing",
  "checkout_ready",
  "paid",
  "reconciliation_required",
]);

export function evaluatePurchasePermit(
  intent: PurchasePermit,
  product: Product | null,
  now = new Date(),
): PolicyDecision {
  const reasons: ReasonCode[] = [];
  const observedPricePaise = product?.pricePaise ?? 0;
  const observedAt = now.toISOString();

  if (replayStatuses.has(intent.status)) reasons.push("REPLAY_DETECTED");
  if (new Date(intent.expiresAt).getTime() <= now.getTime()) reasons.push("EXPIRED");
  if (intent.confirmationRequired && !intent.confirmedAt) reasons.push("CONFIRMATION_REQUIRED");

  if (!product || !product.active) {
    reasons.push("PRODUCT_INACTIVE");
  } else {
    if (product.id !== intent.productId) reasons.push("PRODUCT_MISMATCH");
    if (product.merchantId !== intent.merchantId) reasons.push("MERCHANT_MISMATCH");
    if (product.currency !== intent.currency) reasons.push("CURRENCY_MISMATCH");

    if (product.pricePaise > intent.maxTotalPaise) reasons.push("BUDGET_EXCEEDED");
    if (intent.priceChangePolicy === "none" && product.pricePaise !== intent.lockedUnitPricePaise) {
      reasons.push("PRICE_CHANGED");
    }
    if (
      intent.priceChangePolicy === "decrease_only" &&
      product.pricePaise > intent.lockedUnitPricePaise
    ) {
      reasons.push("PRICE_CHANGED");
    }
    if (intent.requireRefundable && !product.refundable) reasons.push("NOT_REFUNDABLE");
    if (
      intent.minimumRefundWindowDays !== null &&
      product.refundWindowDays < intent.minimumRefundWindowDays
    ) {
      reasons.push("REFUND_POLICY_CHANGED");
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    allowed: uniqueReasons.length === 0,
    reasons: uniqueReasons.length === 0 ? ["ALLOWED"] : uniqueReasons,
    message:
      uniqueReasons.length === 0
        ? "Every PurchasePermit constraint passed. Checkout may be prepared."
        : `Checkout blocked: ${uniqueReasons.join(", ")}.`,
    evaluatedAt: observedAt,
    observedAt,
    observedPricePaise,
    observedProductVersion: product?.version ?? null,
    observedProductRevisionId: product?.revisionId ?? null,
    observedProductSnapshotHash: product?.snapshotHash ?? null,
    catalogAuthority: product?.catalogAuthority ?? null,
  };
}
