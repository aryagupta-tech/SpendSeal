import { describe, expect, it } from "vitest";
import { actionRequired, adapterForUrl, availablePaymentOptions, canonicalProductId, checkoutAmounts, checkoutStage, isProductUrlForSite, normalizeCheckoutControlText, parseRupees } from "./adapters";

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

  it("recognizes only real product pages on the task website", () => {
    expect(isProductUrlForSite("amazon_in", "https://www.amazon.in/Logitech-Mouse/dp/B0ABC12345")).toBe(true);
    expect(isProductUrlForSite("amazon_in", "https://www.amazon.in/s?k=mouse")).toBe(false);
    expect(isProductUrlForSite("amazon_in", "https://amazon.in.attacker.example/dp/B0ABC12345")).toBe(false);
    expect(isProductUrlForSite("flipkart_in", "https://www.flipkart.com/mouse/p/itm123?pid=MOUABC123")).toBe(true);
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

  it("recognizes checkout stages and payment choices from sanitized pages", () => {
    expect(checkoutStage("Select a delivery address Use this address")).toBe("address");
    expect(checkoutStage("Choose a delivery option FREE delivery")).toBe("delivery");
    expect(checkoutStage("Select a payment method Cash on Delivery UPI")).toBe("payment");
    expect(checkoutStage("Review your order Order total ₹950")).toBe("review");
    expect(availablePaymentOptions("Pay on Delivery, UPI, credit card or Net Banking")).toEqual({ cashOnDelivery: true, online: true });
  });

  it("normalizes Amazon final-order control identities", () => {
    expect(normalizeCheckoutControlText("placeYourOrder1 submit.place-order")).toBe("place Your Order1 submit place order");
    expect(/place (?:your )?order/i.test(normalizeCheckoutControlText("placeYourOrder1"))).toBe(true);
  });
});
