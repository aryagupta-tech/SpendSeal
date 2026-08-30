export type AdapterSite = "amazon_in" | "flipkart_in";

export function adapterForUrl(raw: string): AdapterSite | null {
  const host = new URL(raw).hostname.toLowerCase();
  if (["amazon.in", "www.amazon.in"].includes(host)) return "amazon_in";
  if (["flipkart.com", "www.flipkart.com"].includes(host)) return "flipkart_in";
  return null;
}

export function canonicalProductId(site: AdapterSite, raw: string, html = ""): string | null {
  const url = new URL(raw);
  if (adapterForUrl(raw) !== site) return null;
  if (site === "amazon_in") {
    return url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase()
      ?? html.match(/"asin"\s*:\s*"([A-Z0-9]{10})"/i)?.[1]?.toUpperCase()
      ?? null;
  }
  return url.searchParams.get("pid")
    ?? url.pathname.match(/\/p\/([A-Za-z0-9]+)/)?.[1]
    ?? html.match(/"productId"\s*:\s*"([A-Z0-9]+)"/i)?.[1]
    ?? null;
}

export function parseRupees(value: string): number {
  const match = value.replaceAll(",", "").match(/(?:₹|Rs\.?|INR)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  return match?.[1] ? Math.round(Number(match[1]) * 100) : 0;
}

export function checkoutAmounts(text: string) {
  const amount = (label: string) => parseRupees(text.match(new RegExp(`(?:${label})[^₹0-9]{0,20}(₹?\\s*[0-9,.]+)`, "i"))?.[1] ?? "");
  const itemSubtotalPaise = amount("item(?:s)? subtotal|subtotal");
  const shippingPaise = amount("shipping|delivery charge");
  const taxPaise = amount("tax|gst");
  const discountPaise = amount("discount|promotion");
  const finalTotalPaise = amount("order total|amount payable|total amount|grand total");
  return { itemSubtotalPaise, shippingPaise, taxPaise, discountPaise, finalTotalPaise };
}

export function actionRequired(text: string): "captcha" | "login" | "otp" | null {
  const value = text.toLowerCase();
  if (/captcha|verify you are human|enter the characters/.test(value)) return "captcha";
  if (/enter otp|one time password|3d secure/.test(value)) return "otp";
  if (/login to continue|sign in to continue/.test(value)) return "login";
  return null;
}
