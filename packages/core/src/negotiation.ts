import { z } from "zod";
import { DEAL_RESPONSES, DEAL_STATUSES } from "./schemas.js";

export const DealPolicySchema = z.object({
  id: z.string().uuid(), merchantId: z.string().uuid(), productId: z.string().uuid(), version: z.number().int().positive(),
  active: z.boolean(), minimumPricePaise: z.number().int().positive().nullable(), createdBy: z.string().uuid(), createdAt: z.string().datetime(),
});
export type DealPolicy = z.infer<typeof DealPolicySchema>;

export const PublicDealPolicySchema = DealPolicySchema.omit({ minimumPricePaise: true }).extend({ configured: z.boolean() });
export type PublicDealPolicy = z.infer<typeof PublicDealPolicySchema>;

export const DealRoundSchema = z.object({
  sequence: z.number().int().min(1).max(3), buyerOfferPaise: z.number().int().positive(), response: z.enum(DEAL_RESPONSES),
  merchantCounterPaise: z.number().int().positive().nullable(), reasonCode: z.enum(["NO_DEAL", "ALLOWED"]).nullable(), createdAt: z.string().datetime(),
});
export type DealRound = z.infer<typeof DealRoundSchema>;

export const PriceNegotiationSchema = z.object({
  id: z.string().uuid(), buyerId: z.string().uuid(), merchantId: z.string().uuid(), productId: z.string().uuid(),
  productName: z.string(), productRevisionId: z.string().uuid(), productSnapshotHash: z.string(), publicPricePaise: z.number().int().positive(),
  buyerMaxTotalPaise: z.number().int().positive(), policyVersion: z.number().int().positive(), status: z.enum(DEAL_STATUSES),
  roundCount: z.number().int().min(0).max(3), acceptedPricePaise: z.number().int().positive().nullable(), purchasePermitId: z.string().uuid().nullable(),
  expiresAt: z.string().datetime(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), rounds: z.array(DealRoundSchema),
});
export type PriceNegotiation = z.infer<typeof PriceNegotiationSchema>;

export type NegotiationOutcome = { response: "counter"; counterPaise: number } | { response: "accepted" } | { response: "rejected"; reasonCode: "NO_DEAL" };

export function merchantThreshold(publicPricePaise: number, minimumPricePaise: number, round: 1 | 2): number {
  if (!Number.isInteger(publicPricePaise) || !Number.isInteger(minimumPricePaise) || minimumPricePaise <= 0 || minimumPricePaise >= publicPricePaise) throw new Error("INVALID_DEAL_POLICY");
  const progress = round === 1 ? 25 : 60;
  return publicPricePaise - Math.floor((publicPricePaise - minimumPricePaise) * progress / 100);
}

export function evaluateNegotiationOffer(input: { publicPricePaise: number; minimumPricePaise: number; round: 1 | 2 | 3; offerPaise: number }): NegotiationOutcome {
  if (input.round === 3) return input.offerPaise >= input.minimumPricePaise ? { response: "accepted" } : { response: "rejected", reasonCode: "NO_DEAL" };
  const threshold = merchantThreshold(input.publicPricePaise, input.minimumPricePaise, input.round);
  return input.offerPaise >= threshold ? { response: "accepted" } : { response: "counter", counterPaise: threshold };
}
