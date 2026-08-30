import { describe, expect, it } from "vitest";
import { actionRequired, adapterForUrl, canonicalProductId, checkoutAmounts, parseRupees } from "./adapters";

describe("versioned browser adapters", () => {
  it("accepts only the exact supported domains", () => {
    expect(adapterForUrl("https://www.amazon.in/dp/B0ABC12345")).toBe("amazon_in");
    expect(adapterForUrl("https://www.flipkart.com/item/p/itm123?pid=ABC123")).toBe("flipkart_in");
    expect(adapterForUrl("https://amazon.in.attacker.example/dp/B0ABC12345")).toBeNull();
  });

  it("extracts canonical product identities from sanitized fixtures", () => {
    expect(canonicalProductId("amazon_in", "https://www.amazon.in/example/dp/B0ABC12345")).toBe("B0ABC12345");
    expect(canonicalProductId("flipkart_in", "https://www.flipkart.com/example/p/itm123?pid=MOB123XYZ")).toBe("MOB123XYZ");
  });

  it("parses complete checkout charges in paise", () => {
    const amounts = checkoutAmounts("Items subtotal ₹899.00 Shipping ₹40.00 GST ₹61.00 Discount ₹50.00 Order total ₹950.00");
    expect(amounts).toEqual({ itemSubtotalPaise: 89900, shippingPaise: 4000, taxPaise: 6100, discountPaise: 5000, finalTotalPaise: 95000 });
    expect(parseRupees("₹1,025.50")).toBe(102550);
  });

  it("pauses for security challenges", () => {
    expect(actionRequired("Please verify you are human")).toBe("captcha");
    expect(actionRequired("Enter OTP to continue")).toBe("otp");
  });
});
