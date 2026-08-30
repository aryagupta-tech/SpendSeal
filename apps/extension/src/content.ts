import { availablePaymentOptions, checkoutAmounts, checkoutStage } from "./adapters";
declare const chrome: any;
(() => {
  if ((globalThis as any).__spendsealLoaded) return;
  (globalThis as any).__spendsealLoaded = true;
  const VERSION = "2.0.0";
  chrome.runtime.onMessage.addListener((message: any, _sender: any, respond: (value: any) => void) => {
    void run(message).then(respond).catch((error) => respond({ error: error instanceof Error ? error.message : "Inspection failed" })); return true;
  });
  let changeTimer: number | null = null;
  let lastManualProductSignal = "";
  document.addEventListener("change", () => {
    if (changeTimer !== null) window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => { void chrome.runtime.sendMessage({ type: "checkoutChanged" }).catch(() => undefined); }, 500);
  }, true);
  const signalManualProduct = () => {
    const site = siteFor(location.hostname);
    if (site !== "amazon_in" && site !== "flipkart_in") return;
    const id = productId(location.href, site);
    if (!id) return;
    const signature = `${location.href.split("#")[0]}:${id}`;
    if (signature === lastManualProductSignal) return;
    lastManualProductSignal = signature;
    void chrome.runtime.sendMessage({ type: "manualProductPageChanged" }).catch(() => undefined);
  };
  window.addEventListener("pageshow", signalManualProduct);
  window.addEventListener("popstate", signalManualProduct);
  window.setInterval(signalManualProduct, 750);
  signalManualProduct();
  async function run(message: any) {
    if (window.top !== window) return { error: "Embedded checkout frames are refused." };
    const site = siteFor(location.hostname); if (!site) return { kind: "inspect_only", reason: "SITE_NOT_SUPPORTED" };
    if (blocked()) return { userActionRequired: true, reason: actionReason() };
    if (message.action === "inspectProduct") return inspectProduct(site, message.query, message.maxTotalPaise);
    if (message.action === "redactedSnapshot") return { kind: "redacted_page", snapshot: redactedSnapshot(site) };
    if (message.action === "operatorAction") return operatorAction(message.operatorAction);
    if (message.action === "buyNow") return clickBuyNow(site);
    if (message.action === "configureCheckout") return configureCheckout(site, message.paymentPreference ?? null, message.fxQuote ?? null);
    if (message.action === "choosePayment") return choosePayment(site, message.paymentPreference);
    if (message.action === "submitLive") return submitLive(message);
    if (message.action === "executionOutcome") return executionOutcome();
    if (message.action !== "inspect") throw new Error("Unknown page command");
    return isCheckout(site) ? checkout(site, message.paymentPreference ?? null, message.fxQuote ?? null) : candidates(site, message.query, message.maxTotalPaise);
  }
  function siteFor(host: string) { const value = host.toLowerCase(); if (["amazon.in", "www.amazon.in"].includes(value)) return "amazon_in"; if (["flipkart.com", "www.flipkart.com"].includes(value)) return "flipkart_in"; if (value === "platform.openai.com") return "openai_api"; return location.protocol === "https:" ? "generic_web" : null; }
  function blocked() { const value = document.body.innerText.toLowerCase(); return /captcha|enter the characters|verify you are human|login to continue|enter otp|one time password|3d secure/.test(value); }
  function actionReason() { const value = document.body.innerText.toLowerCase(); if (value.includes("captcha") || value.includes("verify you are human")) return "CAPTCHA requires the user."; if (value.includes("otp") || value.includes("3d secure")) return "Bank or OTP challenge requires the user."; return "Sign in requires the user."; }
  function isCheckout(site: string) { if (site === "amazon_in") return /checkout|buy\/spc|gp\/buy/.test(location.pathname); if (site === "flipkart_in") return /checkout|payment|buy-now/.test(location.pathname); return /billing|checkout|payment|credits?/.test(location.pathname) && /pay|purchase|buy|total|credit balance/i.test(document.body.innerText); }
  async function candidates(site: string, query?: string | null, maxTotalPaise?: number) {
    const selector = site === "amazon_in" ? "[data-component-type='s-search-result'], #dp-container" : "[data-id], div[data-tkid]";
    const cards = [...document.querySelectorAll(selector)].slice(0, 40) as HTMLElement[];
    const ranked: { candidate: any; relevance: number; rating: number; reviewCount: number }[] = [];
    const queryTerms = meaningfulTerms(query ?? "");
    const seen = new Set<string>();
    for (const card of cards) {
      const link = card.querySelector("a[href]") as HTMLAnchorElement | null; const productUrl = canonical(link?.href ?? location.href, site); const canonicalProductId = productId(productUrl, site);
      const title = text(card, site === "amazon_in" ? "h2, #productTitle" : "a[title], .VU-ZEz, h1") || document.title;
      const pricePaise = money(text(card, site === "amazon_in" ? ".a-price .a-offscreen, #priceblock_ourprice, .a-price-whole" : "._30jeq3, .Nx9bqj, div[class*='price']"));
      if (!canonicalProductId || !title || !pricePaise || seen.has(canonicalProductId)) continue;
      if (typeof maxTotalPaise === "number" && pricePaise > maxTotalPaise) continue;
      const relevance = relevanceScore(title, queryTerms);
      const requiredCoverage = queryTerms.length <= 1 ? 1 : 0.5;
      if (queryTerms.length && relevance.coverage < requiredCoverage) continue;
      seen.add(canonicalProductId);
      const rating = ratingFromCard(card, site); const reviewCount = reviewCountFromCard(card, site); const deliveryEstimate = deliveryEstimateFromCard(card); const imageUrl = (card.querySelector("img") as HTMLImageElement | null)?.src ?? null;
      const reasons = [`${Math.round(relevance.coverage * 100)}% query match`, rating ? `${rating}/5 rating${reviewCount ? ` from ${reviewCount.toLocaleString("en-IN")} reviews` : ""}` : "Review score unavailable", seller(card, site) ? `Seller: ${seller(card, site)}` : "Seller shown on product page", `${Math.max(0, Math.round(((maxTotalPaise ?? pricePaise) - pricePaise) / 100)).toLocaleString("en-IN")} rupees below the item budget`];
      const candidate: any = { canonicalProductId, listingId: canonicalProductId, title, seller: seller(card, site), variant: variant(card), condition: productCondition(card), availability: "available", pricePaise, currency: "INR", productUrl, observedAt: new Date().toISOString(), adapterId: site, adapterVersion: VERSION, imageUrl, rating: rating || null, reviewCount: reviewCount || null, deliveryEstimate, rankingReasons: reasons, proposalSource: "recommended", queryMismatch: false };
      candidate.snapshotHash = await digest(candidate);
      ranked.push({ candidate, relevance: relevance.score, rating, reviewCount });
    }
    ranked.sort((left, right) => {
      const leftQuality = left.relevance * 40 + left.rating * 5 + Math.log10(left.reviewCount + 1) * 15 + (left.candidate.seller ? 15 : 0) + (left.candidate.deliveryEstimate ? 10 : 0) + Math.max(0, 10 - left.candidate.pricePaise / Math.max(1, maxTotalPaise ?? left.candidate.pricePaise) * 10);
      const rightQuality = right.relevance * 40 + right.rating * 5 + Math.log10(right.reviewCount + 1) * 15 + (right.candidate.seller ? 15 : 0) + (right.candidate.deliveryEstimate ? 10 : 0) + Math.max(0, 10 - right.candidate.pricePaise / Math.max(1, maxTotalPaise ?? right.candidate.pricePaise) * 10);
      return rightQuality - leftQuality || left.candidate.pricePaise - right.candidate.pricePaise;
    });
    const best = ranked.slice(0, 3);
    return best.length ? {
      kind: "candidates",
      candidates: best.map(({ candidate }) => candidate),
      ranking: best.map(({ candidate, rating, reviewCount }, index) => ({ canonicalProductId: candidate.canonicalProductId, rank: index + 1, rating: rating || null, reviewCount: reviewCount || null, reasons: candidate.rankingReasons })),
    } : { kind: "unknown", reason: "NO_MATCHING_PRODUCTS_UNDER_BUDGET" };
  }
  async function inspectProduct(site: string, query?: string | null, maxTotalPaise?: number) {
    const retailer = site === "amazon_in" || site === "flipkart_in"; const canonicalProductId = retailer ? productId(location.href, site) : site === "openai_api" ? "openai-api-prepaid-credits" : await digest({ origin: location.origin, path: location.pathname });
    if (!canonicalProductId) return { kind: "unknown", reason: "NOT_A_PRODUCT_PAGE" };
    if (site === "generic_web" && !genericProductEvidence()) return { kind: "unknown", reason: "NOT_A_PRODUCT_PAGE" };
    const title = site === "openai_api" ? "OpenAI API prepaid credits" : text(document, site === "amazon_in" ? "#productTitle" : site === "flipkart_in" ? "h1, .VU-ZEz" : "h1, [itemprop='name'], meta[property='og:title']") || document.title;
    const rawPrice = site === "openai_api" ? Math.floor((maxTotalPaise ?? 1_000_00) / 1.1) : site === "generic_web" ? genericProductPrice() : money(text(document, site === "amazon_in" ? ".a-price .a-offscreen, #corePrice_feature_div .a-offscreen" : ".Nx9bqj, ._30jeq3"));
    if (!title || !rawPrice) return { kind: "unknown", reason: "PRODUCT_PRICE_UNVERIFIABLE" };
    const terms = meaningfulTerms(query ?? ""); const mismatch = terms.length ? relevanceScore(title, terms).coverage < 0.5 : false; const rating = retailer ? ratingFromCard(document, site) : 0; const reviewCount = retailer ? reviewCountFromCard(document, site) : 0;
    const candidate: any = { canonicalProductId, listingId: canonicalProductId, title, seller: retailer ? seller(document, site) : site === "openai_api" ? "OpenAI" : location.hostname, variant: variant(document), condition: "new", availability: "available", pricePaise: rawPrice, currency: "INR", productUrl: location.href.split("#")[0], observedAt: new Date().toISOString(), adapterId: site, adapterVersion: VERSION, imageUrl: (document.querySelector("#landingImage, meta[property='og:image'], img[itemprop='image']") as HTMLImageElement | HTMLMetaElement | null)?.getAttribute("src") ?? (document.querySelector("meta[property='og:image']") as HTMLMetaElement | null)?.content ?? null, rating: rating || null, reviewCount: reviewCount || null, deliveryEstimate: deliveryEstimateFromCard(document), rankingReasons: ["You opened this product yourself", mismatch ? "It differs from the original search" : "It matches the task request", rawPrice <= (maxTotalPaise ?? rawPrice) ? "Current item price is within the task ceiling" : "Current item price exceeds the task ceiling"], proposalSource: "manual", queryMismatch: mismatch };
    candidate.snapshotHash = await digest(candidate); sessionStorage.setItem("spendseal:selectedProductId", canonicalProductId); sessionStorage.setItem("spendseal:selectedProductTitle", title); return { kind: "product", candidate };
  }
  async function genericCheckout(site: string, paymentPreference: "cash_on_delivery" | "online" | null, fxQuote: any) {
    const value = document.body.innerText; const providerMatch = value.replaceAll(",", "").match(/(?:US\$|USD|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/i); const inrMatch = value.replaceAll(",", "").match(/(?:₹|INR|Rs\.?)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
    const providerAmountMinor = site === "openai_api" ? openAiCreditAmountMinor() : providerMatch?.[1] ? Math.round(Number(providerMatch[1]) * 100) : null;
    const finalTotalPaise = site === "openai_api" && providerAmountMinor && fxQuote
      ? Math.ceil(providerAmountMinor / 100 * Number(fxQuote.rate) * 1.1 * 100 - 1e-6)
      : inrMatch?.[1] ? Math.round(Number(inrMatch[1]) * 100) : providerAmountMinor && fxQuote ? Math.ceil(providerAmountMinor / 100 * Number(fxQuote.rate) * 1.1 * 100 - 1e-6) : 0;
    const canonicalProductId = site === "openai_api" ? "openai-api-prepaid-credits" : sessionStorage.getItem("spendseal:selectedProductId"); const title = site === "openai_api" ? "OpenAI API prepaid credits" : sessionStorage.getItem("spendseal:selectedProductTitle") ?? document.title;
    const account = maskedAccount(); const action = finalActionLabel(); if (!canonicalProductId || !finalTotalPaise || !account.raw || !action) return { kind: "unknown", reason: "CHECKOUT_UNVERIFIABLE" };
    const observation: any = { site, sourceUrl: location.href.split("#")[0], canonicalProductId, listingId: canonicalProductId, title, seller: site === "openai_api" ? "OpenAI" : location.hostname, variant: null, condition: "new", quantity: 1, currency: "INR", itemSubtotalPaise: finalTotalPaise, shippingPaise: 0, taxPaise: 0, discountPaise: 0, finalTotalPaise, extraCartItemCount: 0, refundable: site === "openai_api" ? false : null, returnWindowDays: site === "openai_api" ? 0 : null, deliveryDate: null, maskedAddressLabel: null, addressFingerprint: null, paymentPreference, paymentMethodType: selectedPaymentType() ?? maskedPaymentTypeFromPage(), observedAt: new Date().toISOString(), adapterId: site, adapterVersion: VERSION, evidenceAssurance: site === "generic_web" ? "agent_assisted" : "browser_observed", accountFingerprint: await digest({ origin: location.origin, account: account.raw }), maskedAccountLabel: account.masked, recurring: recurringDetected(), finalActionLabel: action, providerCurrency: providerAmountMinor ? "USD" : null, providerAmountMinor, fxQuote: providerAmountMinor ? fxQuote : null };
    return { kind: "checkout", observation };
  }
  async function checkout(site: string, paymentPreference: "cash_on_delivery" | "online" | null, fxQuote: any = null) {
    const root = document.body;
    if (site === "openai_api" || site === "generic_web") return genericCheckout(site, paymentPreference, fxQuote);
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
    const observation: any = { site, sourceUrl: url, canonicalProductId, listingId: canonicalProductId, title, seller: seller(root, site), variant: variant(root), condition: productCondition(root), quantity, currency: "INR", itemSubtotalPaise: amounts.itemSubtotalPaise || finalTotalPaise, shippingPaise: amounts.shippingPaise, taxPaise: amounts.taxPaise, discountPaise: amounts.discountPaise, finalTotalPaise, extraCartItemCount, refundable: returnable(root.innerText), returnWindowDays: returnDays(root.innerText), deliveryDate: deliveryDate(root.innerText), maskedAddressLabel: maskedAddress(addressText, pin), addressFingerprint: addressText ? await digest({ address: addressText, site }) : pin ? await digest({ pin, site }) : null, paymentPreference, paymentMethodType: selectedPaymentType(), observedAt: new Date().toISOString(), adapterId: site, adapterVersion: VERSION, evidenceAssurance: "browser_observed", accountFingerprint: null, maskedAccountLabel: null, recurring: false, finalActionLabel: finalActionLabel(), providerCurrency: null, providerAmountMinor: null, fxQuote: null };
    return { kind: "checkout", observation };
  }
  async function configureCheckout(site: string, paymentPreference: "cash_on_delivery" | "online" | null, fxQuote: any = null) {
    if (!isCheckout(site)) return { reason: "AUTOMATION_BLOCKED", detail: "SpendSeal is waiting for the website checkout page." };
    const bodyText = document.body.innerText;
    if (site === "openai_api" || site === "generic_web") {
      if (site === "openai_api") {
        const amount = configureOpenAiCreditAmount(fxQuote);
        if (amount.reason) return amount;
        if (amount.changed) return { advanced: true, stage: "billing", detail: `Set the largest protected one-time amount: US$${amount.amountUsd}.` };
      }
      const recurringControl = selectedRecurringControl();
      if (/auto[- ]?recharge|automatically (?:add|purchase|reload)/i.test(bodyText) && recurringControl) {
        if (site === "openai_api") {
          recurringControl.click();
          recurringControl.dispatchEvent(new Event("change", { bubbles: true }));
          return { advanced: true, stage: "billing", detail: "Automatic recharge was turned off. Only this one-time credit purchase is allowed." };
        }
        return { reason: "RECURRING_BILLING_DETECTED", detail: "Recurring billing is enabled. SpendSeal allows only one-time purchases in this version." };
      }
      if (!paymentPreference) return { paymentChoiceRequired: true, cashOnDeliveryAvailable: false, onlineAvailable: true };
      const observed = await checkout(site, paymentPreference, fxQuote); if (observed.kind === "checkout" && checkoutEvidenceComplete(observed.observation)) return { finalReview: true, ...observed };
      return { reason: "CHECKOUT_UNVERIFIABLE", detail: "SpendSeal must see the account, one-time amount, payment type, and exact final purchase control." };
    }
    const stage = checkoutStage(bodyText);
    if (stage === "address") {
      const clicked = clickControl(/use this address|deliver to this address|ship to this address|continue to delivery/i);
      return clicked ? { advanced: true, stage: "address", detail: "Using the website's saved default address." } : { userActionRequired: true, reason: "Choose or add a delivery address on the website, then resume SpendSeal." };
    }
    if (stage === "delivery") {
      const clicked = clickControl(/use this delivery option|continue|save and continue/i);
      return clicked ? { advanced: true, stage: "delivery", detail: "Keeping the website's default delivery option." } : { userActionRequired: true, reason: "Confirm a delivery option on the website, then resume SpendSeal." };
    }
    if (!paymentPreference) {
      const options = availablePaymentOptions(bodyText);
      return { paymentChoiceRequired: true, cashOnDeliveryAvailable: options.cashOnDelivery, onlineAvailable: options.online || stage !== "payment" };
    }
    if (paymentPreference === "online" && selectedPaymentType() === null) {
      if (stage === "review") clickControl(/change.*payment|payment method/i);
      return { paymentActionRequired: true, reason: "Choose UPI, card or netbanking directly on the website, then return to SpendSeal." };
    }
    if (stage === "payment") {
      const clicked = clickControl(/use this payment method|continue|save and continue/i);
      if (clicked) return { advanced: true, stage: "payment", detail: "Opening the final order review." };
    }
    const observed = await checkout(site, paymentPreference, fxQuote);
    if (observed.kind === "checkout" && checkoutEvidenceComplete(observed.observation)) return { finalReview: true, ...observed };
    return { reason: "CHECKOUT_UNVERIFIABLE", detail: "SpendSeal cannot yet read the saved address, delivery date, payment type and complete total. Keep the final review page visible and retry." };
  }
  function choosePayment(_site: string, preference: "cash_on_delivery" | "online") {
    if (preference === "online") {
      if (checkoutStage(document.body.innerText) === "review") clickControl(/change.*payment|payment method/i);
      return { selected: true, paymentActionRequired: true, detail: "Choose UPI, card or netbanking on the website. SpendSeal never reads the account or card details." };
    }
    const choice = findPaymentChoice(/cash on delivery|pay on delivery|cash\/pay on delivery/i);
    if (!choice) return { selected: false, reason: "PAYMENT_OPTION_UNAVAILABLE", detail: "Cash on Delivery is not offered for this order or delivery address." };
    choice.click();
    const radio = choice.matches("input[type='radio']") ? choice : choice.querySelector("input[type='radio']") as HTMLElement | null;
    radio?.click();
    clickControl(/use this payment method|continue|save and continue/i);
    return { selected: true, advanced: true, detail: "Cash on Delivery selected." };
  }
  function clickBuyNow(site: string) {
    const selectors = site === "amazon_in"
      ? ["#buy-now-button", "input[name='submit.buy-now']", "button[name='submit.buy-now']", "[data-action='buy-now'] button", "[data-action='buy-now'] input", "form[action*='/checkout'] input[type='submit']"]
      : ["button", "[role='button']"];
    const elements = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))] as HTMLElement[];
    const button = elements.find((element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      const linkedLabel = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
      const identity = `${element.id} ${element.getAttribute("name") ?? ""} ${element.getAttribute("data-action") ?? ""}`;
      const label = (element.innerText || (element as HTMLInputElement).value || element.getAttribute("aria-label") || linkedLabel || element.textContent || "").replace(/\s+/g, " ").trim();
      const isBuyNowControl = /buy[-_. ]?now/i.test(identity) || /\bbuy\s*now\b/i.test(label);
      return isBuyNowControl && !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true";
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
  function submitLive(message: any) {
    if (message.livePurchaseEnabled !== true || typeof message.executionGrant !== "string" || message.executionGrant.length < 20) return { submitted: false, reason: "LIVE_PURCHASE_DISABLED" };
    const expected = message.paymentPreference === "cash_on_delivery"
      ? /place (?:your )?order|confirm order/i
      : /place (?:your )?order(?: and pay)?|continue to payment|pay now|buy credits|add to (?:credit )?balance|complete purchase/i;
    const button = interactiveElements().find((element) => expected.test(accessibleText(element)) && enabled(element));
    if (!button) return { submitted: false, reason: "AUTOMATION_BLOCKED", detail: "The exact final order control could not be identified safely." };
    button.click(); return { submitted: true };
  }
  function executionOutcome() { const value = document.body.innerText.toLowerCase(); if (blocked()) return { status: "user_action_required", detail: actionReason() }; if (/order (?:has been )?placed|order confirmed|thank you for your order/.test(value)) return { status: "completed", detail: "Visible order confirmation detected." }; if (/payment failed|order failed|could not be completed/.test(value)) return { status: "failed", detail: "Visible failure page detected." }; return { status: "reconciliation_required", detail: "Submission outcome is not unambiguous on the visible page." }; }
  function redactedSnapshot(site: string) {
    const controls = interactiveElements().filter(visible).slice(0, 120).map((element, index) => { const ref = `ss-${index}`; element.dataset.spendsealRef = ref; return { ref, role: element.getAttribute("role") || element.tagName.toLowerCase(), label: redact(accessibleText(element)).slice(0, 160), disabled: !enabled(element) }; }).filter((control) => control.label && !sensitiveLabel(control.label));
    const lines = document.body.innerText.split("\n").map((line) => redact(line.trim())).filter((line) => line.length > 1 && line.length < 240 && !sensitiveLabel(line)).slice(0, 120);
    const prices = lines.filter((line) => /₹|\bINR\b|\bUSD\b|US\$|\$\s*\d/.test(line)).slice(0, 30).map((amount, index) => ({ label: `Visible price ${index + 1}`, amount }));
    return { url: location.href.split("#")[0], title: redact(document.title).slice(0, 240), site, capturedAt: new Date().toISOString(), text: [...new Set(lines)], controls, prices, sensitiveContentRemoved: true, screenshotIncluded: false };
  }
  async function operatorAction(action: any) {
    if (!action || typeof action.type !== "string") return { error: "Invalid operator action" };
    if (action.type === "wait") { await new Promise((resolve) => setTimeout(resolve, action.milliseconds)); return { completed: true }; }
    if (action.type === "scroll") { window.scrollBy({ top: action.direction === "down" ? action.amount : -action.amount, behavior: "smooth" }); return { completed: true }; }
    const element = document.querySelector(`[data-spendseal-ref='${CSS.escape(String(action.ref ?? ""))}']`) as HTMLElement | null; if (!element) return { error: "Visible control reference is stale" };
    const label = accessibleText(element); if (sensitiveElement(element) || sensitiveLabel(label)) return { blocked: true, reason: "SENSITIVE_FIELD_BLOCKED" };
    if (/place (?:your )?order|confirm purchase|buy credits|add to balance|pay now|subscribe|start trial|complete purchase/i.test(label)) return { blocked: true, reason: "Protected final action requires a SpendSeal execution grant" };
    if (action.type === "click") { element.click(); return { completed: true }; }
    if (action.type === "type" && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) { const input = element as HTMLInputElement | HTMLTextAreaElement; input.focus(); input.value = String(action.value ?? ""); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); return { completed: true }; }
    if (action.type === "select" && element instanceof HTMLSelectElement) { element.value = String(action.value ?? ""); element.dispatchEvent(new Event("change", { bubbles: true })); return { completed: true }; }
    return { error: "Action does not match the visible control" };
  }
  function canonical(raw: string, site: string) { const url = new URL(raw, location.href); if (siteFor(url.hostname) !== site) throw new Error("DOMAIN_MISMATCH"); url.hash = ""; ["tag", "ref", "qid", "sr", "affid"].forEach((key) => url.searchParams.delete(key)); return url.toString(); }
  function checkoutEvidenceUrl(raw: string) { const url = new URL(raw); url.search = ""; url.hash = ""; return url.toString(); }
  function productId(url: string, site: string) { const parsed = new URL(url); return site === "amazon_in" ? parsed.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? null : parsed.searchParams.get("pid") ?? parsed.pathname.match(/\/p\/([A-Za-z0-9]+)/)?.[1] ?? null; }
  function productIdFromPage(site: string) { const html = document.documentElement.innerHTML; return site === "amazon_in" ? html.match(/"asin"\s*:\s*"([A-Z0-9]{10})"/i)?.[1] ?? null : html.match(/"productId"\s*:\s*"([A-Z0-9]+)"/i)?.[1] ?? null; }
  function text(root: ParentNode, selector: string) { return (root.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim(); }
  function meaningfulTerms(value: string) { const ignored = new Set(["a", "an", "and", "best", "buy", "find", "for", "in", "me", "of", "on", "the", "under", "with"]); return [...new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((term) => term.length > 1 && !ignored.has(term)))]; }
  function relevanceScore(title: string, terms: string[]) { if (!terms.length) return { score: 0, coverage: 1 }; const normalized = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `; const matched = terms.filter((term) => normalized.includes(` ${term} `)); const coverage = matched.length / terms.length; const phrase = terms.length > 1 && normalized.includes(` ${terms.join(" ")} `) ? 1 : 0; return { coverage, score: coverage * 5 + phrase * 2 }; }
  function ratingFromCard(card: ParentNode, site: string) { const value = text(card, site === "amazon_in" ? ".a-icon-alt, [aria-label*='out of 5 stars']" : "._3LWZlK, [class*='XQDdHH']"); const match = value.match(/([0-5](?:\.[0-9])?)/); return match?.[1] ? Number(match[1]) : 0; }
  function reviewCountFromCard(card: ParentNode, site: string) { const value = text(card, site === "amazon_in" ? ".a-size-base.s-underline-text, [aria-label*='ratings']" : "._2_R_DZ, [class*='Wphh3N']"); const values = [...value.matchAll(/[0-9][0-9,]*/g)].map((match) => Number(match[0].replaceAll(",", ""))).filter(Number.isFinite); return values.length ? Math.max(...values) : 0; }
  function deliveryEstimateFromCard(card: ParentNode) { return text(card, "[data-cy='delivery-recipe'], [class*='delivery'], .a-color-base.a-text-bold").slice(0, 160) || null; }
  function money(value: string) { const match = value.replaceAll(",", "").match(/(?:₹|Rs\.?|INR)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i); return match?.[1] ? Math.round(Number(match[1]) * 100) : 0; }
  function seller(root: ParentNode, site: string) { const selected = text(root, site === "amazon_in" ? "#sellerProfileTriggerId, #merchant-info, [data-testid*='seller']" : "#sellerName, [class*='seller'], [data-testid*='seller']"); if (selected) return selected; return (root.textContent ?? "").match(/(?:sold by|seller)\s*:?\s*([^\n|]{2,80})/i)?.[1]?.trim() ?? null; }
  function variant(root: ParentNode) { return text(root, "#variation_size_name .selection, #variation_color_name .selection, [class*='variant']") || null; }
  function productCondition(root: ParentNode) { const value = (root.textContent ?? "").toLowerCase(); if (/\bused\b/.test(value)) return "used"; if (/refurbished|renewed/.test(value)) return "refurbished"; return "new"; }
  function deliveryAddressText(root: ParentNode, site: string) { const selector = site === "amazon_in" ? "#address-book-entry-0, .ship-to-this-address, #deliver-to-customer-text, .displayAddressDiv, [data-testid*='address']" : "[class*='delivery-address'], [class*='address'], [data-testid*='address']"; return text(root, selector).toLowerCase(); }
  function selectedPaymentType() {
    const selected = document.querySelector("input[type='radio']:checked") as HTMLInputElement | null;
    const explicitLabel = selected?.id ? document.querySelector(`label[for='${CSS.escape(selected.id)}']`) : null;
    const container = explicitLabel ?? selected?.closest("label, [role='radio'], .a-box");
    const selectedText = container?.textContent ?? selected?.getAttribute("aria-label") ?? text(document, "[aria-checked='true'], [class*='selected'][class*='payment']");
    return paymentType(selectedText);
  }
  function quantityFromPage() { const select = document.querySelector("select[name='quantity']") as HTMLSelectElement | null; const raw = select?.value ?? text(document, "[class*='quantity'], .a-dropdown-prompt"); return Number(raw.match(/\d+/)?.[0] ?? 1); }
  function itemCount(site: string) { return document.querySelectorAll(site === "amazon_in" ? ".spc-order" : "[class*='cart-item'], [class*='order-item']").length || 1; }
  function returnable(value: string) { if (/non[- ]?returnable|not returnable|no returns/i.test(value)) return false; if (/returnable|returns? within|replacement/i.test(value)) return true; return null; }
  function returnDays(value: string) { const match = value.match(/(\d+)\s*day[s]?\s*(?:return|replacement)/i); return match?.[1] ? Number(match[1]) : null; }
  function deliveryDate(value: string) { const match = value.match(/(?:delivery|arrives?|delivered by).{0,50}(?:(?:[A-Za-z]{3,9},?\s+)?(\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?|[A-Za-z]{3,9}\s+\d{1,2}(?:,?\s+\d{4})?))/i); if (!match?.[1]) return null; const withYear = /\d{4}/.test(match[1]) ? match[1] : `${match[1]} ${new Date().getFullYear()}`; const parsed = new Date(withYear); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10); }
  function paymentType(value: string) { if (/cash on delivery|pay on delivery/i.test(value)) return "cash_on_delivery"; if (/upi/i.test(value)) return "upi"; if (/credit|debit|card/i.test(value)) return "card"; if (/net ?banking/i.test(value)) return "netbanking"; return null; }
  function maskedAddress(value: string, pin: string | null) { if (!value && !pin) return null; const city = value.match(/(?:^|,|\s)([a-z][a-z ]{2,24})\s+[1-9][0-9]{5}/i)?.[1]?.trim(); return `${city ? `${city} · ` : ""}PIN ••••${pin?.slice(-2) ?? "••"}`; }
  function checkoutEvidenceComplete(observation: any) { const common = observation.canonicalProductId && observation.finalTotalPaise && observation.paymentPreference && observation.paymentMethodType && observation.finalActionLabel && !observation.recurring; if (observation.site === "amazon_in" || observation.site === "flipkart_in") return Boolean(common && observation.seller && observation.deliveryDate && observation.maskedAddressLabel && observation.addressFingerprint); return Boolean(common && observation.maskedAccountLabel && observation.accountFingerprint && (observation.site !== "openai_api" || observation.fxQuote)); }
  function interactiveElements() { return [...document.querySelectorAll("button, input[type='submit'], input[type='button'], a[role='button'], [role='button']")] as HTMLElement[]; }
  function accessibleText(element: HTMLElement) { const ids = element.getAttribute("aria-labelledby")?.split(/\s+/) ?? []; const linked = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" "); return `${element.id} ${element.getAttribute("name") ?? ""} ${element.getAttribute("aria-label") ?? ""} ${linked} ${element.innerText || (element as HTMLInputElement).value || element.textContent || ""}`.replace(/\s+/g, " ").trim(); }
  function enabled(element: HTMLElement) { return !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true" && getComputedStyle(element).visibility !== "hidden"; }
  function visible(element: HTMLElement) { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0; }
  function clickControl(pattern: RegExp) { const control = interactiveElements().find((element) => pattern.test(accessibleText(element)) && !/place (?:your )?order|pay now/i.test(accessibleText(element)) && enabled(element)); control?.click(); return Boolean(control); }
  function findPaymentChoice(pattern: RegExp) {
    const radios = [...document.querySelectorAll("input[type='radio']")] as HTMLInputElement[];
    const radio = radios.find((input) => { const label = input.id ? document.querySelector(`label[for='${CSS.escape(input.id)}']`) : input.closest("label, [role='radio'], .a-box"); return pattern.test(`${input.getAttribute("aria-label") ?? ""} ${label?.textContent ?? ""}`) && enabled(input); });
    if (radio) return radio;
    const controls = [...document.querySelectorAll("label, [role='radio'], [class*='payment']")] as HTMLElement[];
    return controls.find((element) => pattern.test(accessibleText(element)) && enabled(element)) ?? null;
  }
  function finalActionLabel() { const control = interactiveElements().find((element) => /place (?:your )?order|confirm purchase|buy credits|add to (?:credit )?balance|pay now|complete purchase/i.test(accessibleText(element)) && enabled(element)); return control ? accessibleText(control).slice(0, 120) : null; }
  function selectedRecurringControl() { return ([...document.querySelectorAll("input[type='checkbox']:checked, input[type='radio']:checked")] as HTMLInputElement[]).find((element) => /auto[- ]?recharge|recurring|automatically/i.test(`${element.getAttribute("aria-label") ?? ""} ${element.closest("label")?.textContent ?? ""}`)) ?? null; }
  function recurringDetected() { return Boolean(selectedRecurringControl()) || /subscription|recurring charge|renews (?:monthly|yearly)|auto[- ]?recharge enabled/i.test(document.body.innerText); }
  function genericProductEvidence() {
    const structuredProduct = Boolean(document.querySelector("[itemtype*='schema.org/Product'], meta[property='product:price:amount'], [itemprop='price']"));
    const title = Boolean(document.querySelector("h1, [itemprop='name'], meta[property='og:title']"));
    const purchaseControl = interactiveElements().some((element) => /add to (?:cart|bag)|buy now|purchase|checkout|get credits|add to balance/i.test(accessibleText(element)) && enabled(element));
    return purchaseControl && (structuredProduct || title);
  }
  function genericProductPrice() {
    const meta = document.querySelector("meta[property='product:price:amount'], meta[itemprop='price']") as HTMLMetaElement | null;
    const attribute = document.querySelector("[itemprop='price']")?.getAttribute("content");
    const explicit = meta?.content ?? attribute ?? text(document, "[itemprop='price'], [class*='price']");
    return money(explicit);
  }
  function configureOpenAiCreditAmount(fxQuote: any): { changed?: boolean; amountUsd?: number; reason?: string; detail?: string } {
    const safeMinor = Number(fxQuote?.safeProviderAmountMinor);
    if (!Number.isInteger(safeMinor) || safeMinor < 500) return { reason: "FX_QUOTE_UNAVAILABLE", detail: "The INR limit is too low for the minimum US$5 prepaid-credit purchase or the exchange-rate quote is unavailable." };
    const input = findOpenAiAmountInput();
    const minimumUsd = Math.max(5, Number(input?.min || 5));
    const maximumUsd = input?.max && Number(input.max) > 0 ? Number(input.max) : Number.POSITIVE_INFINITY;
    const amountUsd = Math.min(Math.floor(safeMinor / 100), maximumUsd);
    if (amountUsd < minimumUsd) return { reason: "BUDGET_EXCEEDED", detail: `The protected INR ceiling is below this account's minimum supported US$${minimumUsd} credit purchase.` };
    if (!input) return { amountUsd };
    if (Number(input.value) === amountUsd) return { amountUsd };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, String(amountUsd));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { changed: true, amountUsd };
  }
  function findOpenAiAmountInput() {
    return ([...document.querySelectorAll("input")] as HTMLInputElement[]).find((input) => {
      if (sensitiveElement(input)) return false;
      const label = input.id ? document.querySelector(`label[for='${CSS.escape(input.id)}']`)?.textContent ?? "" : input.closest("label")?.textContent ?? "";
      return /amount|credits?|prepaid|balance/i.test(`${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") ?? ""} ${label}`) && /number|text/.test(input.type);
    }) ?? null;
  }
  function openAiCreditAmountMinor() {
    const input = findOpenAiAmountInput();
    if (input && Number(input.value) > 0) return Math.round(Number(input.value) * 100);
    const summary = document.body.innerText.replaceAll(",", "").match(/(?:purchase amount|credits?|amount to add|total)[^\n$]{0,50}(?:US\$|USD|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
    return summary?.[1] ? Math.round(Number(summary[1]) * 100) : null;
  }
  function maskedAccount() { const raw = text(document, "[data-testid*='organization'], [class*='organization'], [class*='workspace'], button[aria-label*='organization']") || location.hostname; const email = document.body.innerText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]; const value = email ?? raw; return { raw: value.slice(0, 160), masked: email ? `${email.slice(0, 2)}•••@${email.split("@")[1]}` : `${value.slice(0, 3)}•••` };
  }
  function maskedPaymentTypeFromPage() { const value = text(document, "[class*='payment-method'], [data-testid*='payment'], [aria-label*='payment']"); if (/visa|mastercard|amex|card ending|••••/i.test(value)) return "saved_card"; if (/upi/i.test(value)) return "upi"; if (/net ?banking/i.test(value)) return "netbanking"; return /payment method|billing/i.test(document.body.innerText) ? "saved_payment" : null; }
  function sensitiveElement(element: HTMLElement) { if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false; const value = `${element.type} ${element.name} ${element.id} ${element.autocomplete} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase(); return /password|one-time-code|otp|cvv|cvc|card|credit-card|cc-|upi.*pin|security code|captcha/.test(value); }
  function sensitiveLabel(value: string) { return /password|one[- ]time password|\botp\b|\bcvv\b|\bcvc\b|upi pin|security code|captcha|card number/i.test(value); }
  function redact(value: string) { return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "•••@masked").replace(/\b(?:\+?91[- ]?)?[6-9]\d{9}\b/g, "••••••••••").replace(/\b(?:\d[ -]*?){13,19}\b/g, "•••• •••• •••• ••••").replace(/\b[1-9][0-9]{5}\b/g, "PIN ••••"); }
  async function digest(value: unknown) { const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))); return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
})();
