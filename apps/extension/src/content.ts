import { checkoutAmounts } from "./adapters";
declare const chrome: any;
(() => {
  if ((globalThis as any).__spendsealLoaded) return;
  (globalThis as any).__spendsealLoaded = true;
  const VERSION = "1.0.0";
  chrome.runtime.onMessage.addListener((message: any, _sender: any, respond: (value: any) => void) => {
    void run(message).then(respond).catch((error) => respond({ error: error instanceof Error ? error.message : "Inspection failed" })); return true;
  });
  async function run(message: any) {
    if (window.top !== window) return { error: "Embedded checkout frames are refused." };
    const site = siteFor(location.hostname); if (!site) return { kind: "inspect_only", reason: "SITE_NOT_SUPPORTED" };
    if (blocked()) return { userActionRequired: true, reason: actionReason() };
    if (message.action === "buyNow") return clickBuyNow(site);
    if (message.action === "submitLive") return submitLive(message);
    if (message.action === "executionOutcome") return executionOutcome();
    if (message.action !== "inspect") throw new Error("Unknown page command");
    return isCheckout(site) ? checkout(site) : candidates(site);
  }
  function siteFor(host: string) { const value = host.toLowerCase(); if (["amazon.in", "www.amazon.in"].includes(value)) return "amazon_in"; if (["flipkart.com", "www.flipkart.com"].includes(value)) return "flipkart_in"; return null; }
  function blocked() { const value = document.body.innerText.toLowerCase(); return /captcha|enter the characters|verify you are human|login to continue|enter otp|one time password|3d secure/.test(value); }
  function actionReason() { const value = document.body.innerText.toLowerCase(); if (value.includes("captcha") || value.includes("verify you are human")) return "CAPTCHA requires the user."; if (value.includes("otp") || value.includes("3d secure")) return "Bank or OTP challenge requires the user."; return "Sign in requires the user."; }
  function isCheckout(site: string) { return site === "amazon_in" ? /checkout|buy\/spc|gp\/buy/.test(location.pathname) : /checkout|payment|buy-now/.test(location.pathname); }
  async function candidates(site: string) {
    const selector = site === "amazon_in" ? "[data-component-type='s-search-result'], #dp-container" : "[data-id], div[data-tkid]";
    const cards = [...document.querySelectorAll(selector)].slice(0, 3) as HTMLElement[]; const found: any[] = [];
    for (const card of cards) {
      const link = card.querySelector("a[href]") as HTMLAnchorElement | null; const productUrl = canonical(link?.href ?? location.href, site); const canonicalProductId = productId(productUrl, site);
      const title = text(card, site === "amazon_in" ? "h2, #productTitle" : "a[title], .VU-ZEz, h1") || document.title;
      const pricePaise = money(text(card, site === "amazon_in" ? ".a-price .a-offscreen, #priceblock_ourprice, .a-price-whole" : "._30jeq3, .Nx9bqj, div[class*='price']"));
      if (!canonicalProductId || !title || !pricePaise) continue;
      const candidate: any = { canonicalProductId, listingId: canonicalProductId, title, seller: seller(card, site), variant: variant(card), condition: productCondition(card), availability: "available", pricePaise, currency: "INR", productUrl, observedAt: new Date().toISOString(), adapterId: site, adapterVersion: VERSION };
      candidate.snapshotHash = await digest(candidate); found.push(candidate);
    }
    return found.length ? { kind: "candidates", candidates: found } : { kind: "unknown", reason: "CHECKOUT_UNVERIFIABLE" };
  }
  async function checkout(site: string) {
    const root = document.body;
    const inspectedUrl = canonical(location.href, site);
    const canonicalProductId = productId(inspectedUrl, site) || productIdFromPage(site);
    const url = checkoutEvidenceUrl(inspectedUrl);
    const title = text(root, site === "amazon_in" ? "#spc-orders h3, .a-text-bold, #productTitle" : "[class*='product-title'], h1") || document.title;
    const totalText = text(root, site === "amazon_in" ? "#subtotals-marketplace-table .grand-total-price, .grand-total-price" : "[class*='total'], [class*='Amount']");
    const amounts = checkoutAmounts(root.innerText);
    const finalTotalPaise = amounts.finalTotalPaise || money(totalText); const quantity = quantityFromPage(); const extraCartItemCount = Math.max(0, itemCount(site) - 1);
    if (!canonicalProductId || !finalTotalPaise) return { kind: "unknown", reason: "CHECKOUT_UNVERIFIABLE" };
    const pin = (root.innerText.match(/[1-9][0-9]{5}/) ?? [])[0] ?? null;
    const addressText = deliveryAddressText(root, site);
    const observation: any = { site, sourceUrl: url, canonicalProductId, listingId: canonicalProductId, title, seller: seller(root, site), variant: variant(root), condition: productCondition(root), quantity, currency: "INR", itemSubtotalPaise: amounts.itemSubtotalPaise || finalTotalPaise, shippingPaise: amounts.shippingPaise, taxPaise: amounts.taxPaise, discountPaise: amounts.discountPaise, finalTotalPaise, extraCartItemCount, refundable: returnable(root.innerText), returnWindowDays: returnDays(root.innerText), deliveryDate: deliveryDate(root.innerText), maskedAddressLabel: pin ? `Delivery PIN ••••${pin.slice(-2)}` : null, addressFingerprint: addressText ? await digest({ address: addressText, site }) : pin ? await digest({ pin, site }) : null, paymentMethodType: selectedPaymentType(), observedAt: new Date().toISOString(), adapterId: site, adapterVersion: VERSION, evidenceAssurance: "browser_observed" };
    return { kind: "checkout", observation };
  }
  function clickBuyNow(site: string) {
    const selectors = site === "amazon_in"
      ? ["#buy-now-button", "input[name='submit.buy-now']", "button[name='submit.buy-now']", "[data-action='buy-now'] button", "[data-action='buy-now'] input", "form[action*='/checkout'] input[type='submit']"]
      : ["button", "[role='button']"];
    const elements = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))] as HTMLElement[];
    const button = elements.find((element) => {
      const label = (element.innerText || (element as HTMLInputElement).value || element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim();
      return /\bbuy\s*now\b/i.test(label) && !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true";
    });
    if (button) { button.click(); return { clicked: true }; }
    const exactProduct = Boolean(productId(location.href, site) || productIdFromPage(site));
    return {
      clicked: false,
      reason: "AUTOMATION_BLOCKED",
      detail: exactProduct
        ? "SpendSeal could not find an enabled Buy Now button. Select the required size, colour, seller or delivery option on the product page, then try again."
        : "Open the exact Amazon or Flipkart product page first, then try again.",
    };
  }
  function submitLive(message: any) { if (message.livePurchaseEnabled !== true || typeof message.executionGrant !== "string" || message.executionGrant.length < 20) return { submitted: false, reason: "LIVE_PURCHASE_DISABLED" }; const buttons = [...document.querySelectorAll("button, input[type='submit']")] as HTMLElement[]; const button = buttons.find((element) => /place (your )?order|confirm order|buy now/i.test(element.innerText || (element as HTMLInputElement).value || "")); if (!button) return { submitted: false, reason: "AUTOMATION_BLOCKED" }; button.click(); return { submitted: true }; }
  function executionOutcome() { const value = document.body.innerText.toLowerCase(); if (blocked()) return { status: "user_action_required", detail: actionReason() }; if (/order (?:has been )?placed|order confirmed|thank you for your order/.test(value)) return { status: "completed", detail: "Visible order confirmation detected." }; if (/payment failed|order failed|could not be completed/.test(value)) return { status: "failed", detail: "Visible failure page detected." }; return { status: "reconciliation_required", detail: "Submission outcome is not unambiguous on the visible page." }; }
  function canonical(raw: string, site: string) { const url = new URL(raw, location.href); if (siteFor(url.hostname) !== site) throw new Error("DOMAIN_MISMATCH"); url.hash = ""; ["tag", "ref", "qid", "sr", "affid"].forEach((key) => url.searchParams.delete(key)); return url.toString(); }
  function checkoutEvidenceUrl(raw: string) { const url = new URL(raw); url.search = ""; url.hash = ""; return url.toString(); }
  function productId(url: string, site: string) { const parsed = new URL(url); return site === "amazon_in" ? parsed.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? null : parsed.searchParams.get("pid") ?? parsed.pathname.match(/\/p\/([A-Za-z0-9]+)/)?.[1] ?? null; }
  function productIdFromPage(site: string) { const html = document.documentElement.innerHTML; return site === "amazon_in" ? html.match(/"asin"\s*:\s*"([A-Z0-9]{10})"/i)?.[1] ?? null : html.match(/"productId"\s*:\s*"([A-Z0-9]+)"/i)?.[1] ?? null; }
  function text(root: ParentNode, selector: string) { return (root.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim(); }
  function money(value: string) { const match = value.replaceAll(",", "").match(/(?:₹|Rs\.?|INR)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i); return match?.[1] ? Math.round(Number(match[1]) * 100) : 0; }
  function seller(root: ParentNode, site: string) { return text(root, site === "amazon_in" ? "#sellerProfileTriggerId, #merchant-info" : "#sellerName, [class*='seller']") || null; }
  function variant(root: ParentNode) { return text(root, "#variation_size_name .selection, #variation_color_name .selection, [class*='variant']") || null; }
  function productCondition(root: ParentNode) { const value = (root.textContent ?? "").toLowerCase(); if (/\bused\b/.test(value)) return "used"; if (/refurbished|renewed/.test(value)) return "refurbished"; return "new"; }
  function deliveryAddressText(root: ParentNode, site: string) { const selector = site === "amazon_in" ? "#address-book-entry-0, .ship-to-this-address, #deliver-to-customer-text" : "[class*='delivery-address'], [class*='address']"; return text(root, selector).toLowerCase(); }
  function selectedPaymentType() { const selected = document.querySelector("input[type='radio']:checked") as HTMLInputElement | null; const container = selected?.closest("label, [role='radio'], div"); return paymentType(container?.textContent ?? ""); }
  function quantityFromPage() { const select = document.querySelector("select[name='quantity']") as HTMLSelectElement | null; const raw = select?.value ?? text(document, "[class*='quantity'], .a-dropdown-prompt"); return Number(raw.match(/\d+/)?.[0] ?? 1); }
  function itemCount(site: string) { return document.querySelectorAll(site === "amazon_in" ? ".spc-order" : "[class*='cart-item'], [class*='order-item']").length || 1; }
  function returnable(value: string) { if (/non[- ]?returnable|not returnable|no returns/i.test(value)) return false; if (/returnable|returns? within|replacement/i.test(value)) return true; return null; }
  function returnDays(value: string) { const match = value.match(/(\d+)\s*day[s]?\s*(?:return|replacement)/i); return match?.[1] ? Number(match[1]) : null; }
  function deliveryDate(value: string) { const match = value.match(/(?:delivery|arrives?).{0,30}(\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?)/i); if (!match?.[1]) return null; const parsed = new Date(match[1]); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10); }
  function paymentType(value: string) { if (/cash on delivery/i.test(value)) return "cash_on_delivery"; if (/upi/i.test(value)) return "upi"; if (/credit|debit|card/i.test(value)) return "card"; if (/net ?banking/i.test(value)) return "netbanking"; return null; }
  async function digest(value: unknown) { const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))); return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
})();
