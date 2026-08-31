import { describe, expect, it } from "vitest";
import { evaluateNegotiationOffer, merchantThreshold } from "./negotiation.js";

describe("bounded dealmaker", () => {
  it("moves merchant counters deterministically toward the private floor", () => {
    expect(merchantThreshold(4995, 4200, 1)).toBe(4797);
    expect(merchantThreshold(4995, 4200, 2)).toBe(4518);
  });

  it("accepts at a round threshold without exposing the floor", () => {
    expect(evaluateNegotiationOffer({ publicPricePaise: 4995, minimumPricePaise: 4200, round: 1, offerPaise: 4000 })).toEqual({ response: "counter", counterPaise: 4797 });
    expect(evaluateNegotiationOffer({ publicPricePaise: 4995, minimumPricePaise: 4200, round: 2, offerPaise: 4520 })).toEqual({ response: "accepted" });
  });

  it("returns no counter after a rejected third offer", () => {
    expect(evaluateNegotiationOffer({ publicPricePaise: 4995, minimumPricePaise: 4200, round: 3, offerPaise: 4199 })).toEqual({ response: "rejected", reasonCode: "NO_DEAL" });
    expect(evaluateNegotiationOffer({ publicPricePaise: 4995, minimumPricePaise: 4200, round: 3, offerPaise: 4200 })).toEqual({ response: "accepted" });
  });
});
