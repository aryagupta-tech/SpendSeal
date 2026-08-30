import type { BrowserPurchasePermit, CheckoutObservation, ReasonCode, ShoppingCandidate, ShoppingTask } from "./schemas.js";
import { sha256 } from "./hashing.js";

const HOSTS = {
  amazon_in: new Set(["amazon.in", "www.amazon.in"]),
  flipkart_in: new Set(["flipkart.com", "www.flipkart.com"]),
} as const;

export function checkoutSnapshotHash(observation: CheckoutObservation): string {
  const { observedAt: _observedAt, ...stableEvidence } = observation;
  return sha256(stableEvidence);
}

export function evaluateBrowserCheckout(input: { task: ShoppingTask; candidate: ShoppingCandidate | null; observation: CheckoutObservation; permit?: BrowserPurchasePermit | null; now?: Date }): { allowed: boolean; reasons: ReasonCode[] } {
  const { task, candidate, observation, permit } = input; const reasons: ReasonCode[] = [];
  const now = input.now ?? new Date();
  const observedAt = new Date(observation.observedAt).getTime();
  const host = safeHost(observation.sourceUrl);
  if (!host || !HOSTS[task.site].has(host) || observation.site !== task.site || observation.adapterId !== task.site) reasons.push("DOMAIN_MISMATCH");
  if (!candidate || observation.canonicalProductId !== candidate.canonicalProductId) reasons.push("PRODUCT_CHANGED");
  if (!observation.listingId || !observation.seller) reasons.push("CHECKOUT_UNVERIFIABLE");
  if (candidate?.listingId && observation.listingId !== candidate.listingId) reasons.push("PRODUCT_CHANGED");
  if (candidate?.seller && observation.seller !== candidate.seller) reasons.push("SELLER_CHANGED");
  if (candidate?.variant && observation.variant !== candidate.variant) reasons.push("VARIANT_CHANGED");
  if (observation.condition.toLowerCase() !== "new") reasons.push("PRODUCT_CHANGED");
  if (observation.quantity !== 1) reasons.push("QUANTITY_CHANGED");
  if (observation.extraCartItemCount > 0) reasons.push("UNEXPECTED_CART_ITEMS");
  if (observation.finalTotalPaise > task.maxTotalPaise) reasons.push("BUDGET_EXCEEDED");
  if (!observation.maskedAddressLabel || !observation.addressFingerprint) reasons.push("CHECKOUT_UNVERIFIABLE");
  if (!observation.deliveryDate) reasons.push("CHECKOUT_UNVERIFIABLE");
  if (!task.paymentPreference) reasons.push("PAYMENT_OPTION_UNAVAILABLE");
  if (task.paymentPreference && observation.paymentPreference !== task.paymentPreference) reasons.push("PAYMENT_METHOD_CHANGED");
  if (!observation.paymentMethodType) reasons.push("PAYMENT_OPTION_UNAVAILABLE");
  if (task.paymentPreference === "cash_on_delivery" && observation.paymentMethodType !== "cash_on_delivery") reasons.push("PAYMENT_METHOD_CHANGED");
  if (task.paymentPreference === "online" && observation.paymentMethodType === "cash_on_delivery") reasons.push("PAYMENT_METHOD_CHANGED");
  if (task.requireRefundable && observation.refundable !== true) reasons.push("NOT_REFUNDABLE");
  if (task.minimumReturnWindowDays !== null && (observation.returnWindowDays ?? -1) < task.minimumReturnWindowDays) reasons.push("REFUND_POLICY_CHANGED");
  if (task.latestDeliveryDate && (!observation.deliveryDate || observation.deliveryDate > task.latestDeliveryDate)) reasons.push("CHECKOUT_UNVERIFIABLE");
  if (observedAt > now.getTime() + 60_000 || observedAt < now.getTime() - 10 * 60_000) reasons.push("CHECKOUT_UNVERIFIABLE");
  if (new Date(task.expiresAt).getTime() <= now.getTime()) reasons.push("EXPIRED");
  if (permit) {
    if (new Date(permit.expiresAt).getTime() <= now.getTime()) reasons.push("EXPIRED");
    if (!permit.confirmedAt) reasons.push("CONFIRMATION_REQUIRED");
    if (permit.status === "prepared" || permit.status === "submitting" || permit.status === "completed") reasons.push("REPLAY_DETECTED");
    const approved = permit.checkoutSnapshot;
    if (approved.addressFingerprint !== observation.addressFingerprint) reasons.push("ADDRESS_CHANGED");
    if (approved.deliveryDate !== observation.deliveryDate) reasons.push("DELIVERY_CHANGED");
    if (approved.paymentPreference !== observation.paymentPreference || approved.paymentMethodType !== observation.paymentMethodType) reasons.push("PAYMENT_METHOD_CHANGED");
    if (approved.finalTotalPaise !== observation.finalTotalPaise) reasons.push("TOTAL_CHANGED");
    if (permit.checkoutSnapshotHash !== checkoutSnapshotHash(observation) && !reasons.some((reason) => ["ADDRESS_CHANGED", "DELIVERY_CHANGED", "PAYMENT_METHOD_CHANGED", "TOTAL_CHANGED"].includes(reason))) reasons.push("CHECKOUT_UNVERIFIABLE");
  }
  return { allowed: reasons.length === 0, reasons: reasons.length ? [...new Set(reasons)] : ["ALLOWED"] };
}

export function allowedShoppingHost(site: ShoppingTask["site"], url: string): boolean { const host = safeHost(url); return Boolean(host && HOSTS[site].has(host)); }
function safeHost(value: string): string | null { try { return new URL(value).hostname.toLowerCase(); } catch { return null; } }
