import { isProductUrlForSite, type AdapterSite } from "./adapters";
declare const chrome: any;
const API = "https://spendseal.vercel.app";
const CLIENT_ID = "spendseal-browser-extension";
const SCOPES = ["browser:tasks:read", "browser:observations:write", "browser:execute"];
const running = new Set<string>();
const manualProductDetections = new Set<string>();
type Flow = { taskId: string; tabId: number; phase: string; retries: number; message: string };

chrome.runtime.onInstalled.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); chrome.alarms.create("spendseal-operator", { periodInMinutes: 0.5 }); });
chrome.alarms.onAlarm.addListener((alarm: any) => { if (alarm.name === "spendseal-operator") void pollOperator(); });
chrome.runtime.onMessage.addListener((message: any, sender: any, respond: (value: any) => void) => {
  void handle(message, sender).then(respond).catch((error) => respond({ error: error instanceof Error ? error.message : "Extension request failed" }));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId: number, change: any, tab: any) => {
  if (change.status !== "complete") return;
  void currentFlow().then(async (flow) => {
    if (!flow) return;
    if (flow.tabId === tabId) {
      await observeVisiblePage(flow).catch(() => undefined);
      await detectManualProduct(flow, tabId, tab?.url).catch(() => undefined);
      return advance(flow.taskId);
    }
    await detectManualProduct(flow, tabId, tab?.url).catch(() => undefined);
  });
});
chrome.tabs.onActivated.addListener(({ tabId }: { tabId: number }) => {
  void currentFlow().then((flow) => flow ? detectManualProduct(flow, tabId).catch(() => undefined) : undefined);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details: any) => {
  if (details.frameId !== 0) return;
  void currentFlow().then((flow) => flow ? detectManualProduct(flow, details.tabId, details.url).catch(() => undefined) : undefined);
});

async function handle(message: any, sender: any) {
  if (message.type === "connect") return connect();
  if (message.type === "state") return state();
  if (message.type === "pending") return api("/api/v1/browser/tasks/pending");
  if (message.type === "task") return api(`/api/v1/browser/tasks/${message.taskId}`);
  if (message.type === "openTask") return openTask(message.task, message.permissionOrigin);
  if (message.type === "inspect") return inspect(message.taskId);
  if (message.type === "propose") return propose(message.taskId, { candidateId: message.candidateId, source: "recommended" });
  if (message.type === "confirmProposal") return confirmProposal(message.taskId, message.proposalId, message.productUrl);
  if (message.type === "dismissProposal") return dismissProposal(message.taskId, message.proposalId);
  if (message.type === "choosePayment") return choosePayment(message.taskId, message.paymentPreference);
  if (message.type === "changeProduct") return changeProduct(message.taskId);
  if (message.type === "approveAndContinue") return approveAndContinue(message.taskId);
  if (message.type === "resume" || message.type === "retry") return advance(message.taskId, true);
  if (message.type === "checkoutChanged") { const flow = await currentFlow(); if (flow && sender.tab?.id === flow.tabId) return advance(flow.taskId, true); return { ignored: true }; }
  if (message.type === "manualProductPageChanged") { const flow = await currentFlow(); if (flow && sender.tab?.id) return detectManualProduct(flow, sender.tab.id, sender.tab.url); return { ignored: true }; }
  if (message.type === "revalidate") return revalidate(message.taskId);
  if (message.type === "finalize") return finalize(message.taskId);
  if (message.type === "disconnect") { await disconnect(); return { connected: false }; }
  throw new Error("Unknown extension command");
}

async function connect() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const redirectUri = chrome.identity.getRedirectURL("oauth2"); const stateValue = crypto.randomUUID(); const url = new URL(`${API}/oauth/authorize`);
  Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, resource: API, code_challenge: challenge, code_challenge_method: "S256", scope: SCOPES.join(" "), state: stateValue }).forEach(([key, value]) => url.searchParams.set(key, value));
  const callback = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  if (!callback) throw new Error("SpendSeal authorization was cancelled.");
  const returned = new URL(callback); if (returned.searchParams.get("state") !== stateValue) throw new Error("OAuth state did not match.");
  const response = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: returned.searchParams.get("code") ?? "", code_verifier: verifier, client_id: CLIENT_ID, redirect_uri: redirectUri, resource: API }) });
  if (!response.ok) throw new Error("SpendSeal token exchange failed.");
  const tokens = await response.json(); let { installationId: savedId } = await chrome.storage.local.get(["installationId"]); savedId ||= crypto.randomUUID();
  await chrome.storage.local.set({ tokens, installationId: savedId });
  const registration = await api("/api/v1/browser/installations", { method: "POST", body: JSON.stringify({ installationId: savedId, name: "Local Chromium extension" }) });
  await chrome.storage.local.set({ livePurchaseEnabled: registration.livePurchaseEnabled === true });
  return { connected: true, installationId: savedId };
}

async function state() {
  const stored = await chrome.storage.local.get(["tokens", "installationId", "activeTaskId", "livePurchaseEnabled", "flow"]);
  let livePurchaseEnabled = stored.livePurchaseEnabled === true;
  if (stored.tokens && stored.installationId) {
    const registration = await api("/api/v1/browser/installations", { method: "POST", body: JSON.stringify({ installationId: stored.installationId, name: "Local Chromium extension" }) });
    livePurchaseEnabled = registration.livePurchaseEnabled === true;
    await chrome.storage.local.set({ livePurchaseEnabled });
  }
  return { connected: Boolean(stored.tokens), installationId: stored.installationId ?? null, activeTaskId: stored.activeTaskId ?? null, livePurchaseEnabled, flow: stored.flow ?? null };
}

async function openTask(task: any, permissionOrigin?: string) {
  await chrome.storage.local.set({ activeTaskId: task.id });
  const target = shoppingStartUrl(task);
  if (!target) throw new Error("This task has no permitted website.");
  const targetOrigin = new URL(target).origin;
  if (permissionOrigin !== targetOrigin) throw new Error("Website permission did not match this Shopping Task.");
  const originPattern = `${targetOrigin}/*`; const granted = await chrome.permissions.contains({ origins: [originPattern] });
  if (!granted) throw new Error("Click Start protected search again and allow access to this website in Chrome's permission prompt.");
  await api(`/api/v1/browser/tasks/${task.id}/site-grant`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), origin: targetOrigin }) });
  await report(task.id, "searching", task.productUrl ? "Opening the exact supplied product for your selection." : "Opening product search.");
  const existing = await currentFlow(); let tabId: number | undefined;
  if (existing && existing.taskId === task.id) {
    const existingTabId = existing.tabId;
    try { const tab = await chrome.tabs.get(existingTabId); if (tab?.id) { tabId = tab.id; await chrome.tabs.update(tab.id, { url: target, active: true }); } } catch { tabId = undefined; }
  }
  if (!tabId) tabId = (await chrome.tabs.create({ url: target, active: true })).id;
  if (!tabId) throw new Error("SpendSeal could not create the shopping tab.");
  await saveFlow({ taskId: task.id, tabId, phase: "searching", retries: 0, message: task.productUrl ? "Reading the exact supplied product" : "Finding matching products" });
  return { opened: target };
}

async function inspect(taskId: string) {
  const details = await api(`/api/v1/browser/tasks/${taskId}`);
  const flow = await ensureFlow(taskId);
  const observed = await commandTab(flow.tabId, "inspect", { site: details.task.site, query: details.task.query ?? null, maxTotalPaise: details.task.maxTotalPaise, paymentPreference: details.task.paymentPreference });
  if (observed.error) throw new Error(observed.error);
  if (observed.userActionRequired) { await report(taskId, "user_action_required", observed.reason); return observed; }
  if (observed.kind === "candidates") {
    const saved = await api(`/api/v1/browser/tasks/${taskId}/candidates`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), candidates: observed.candidates }) });
    await saveFlow({ ...flow, phase: "selection_required", message: "Choose one exact listing" });
    return { ...saved, ranking: observed.ranking ?? [] };
  }
  throw new Error(observed.reason ?? "SpendSeal could not confidently inspect this page.");
}

async function propose(taskId: string, input: { candidateId?: string; candidate?: any; source: "recommended" | "manual" | "agent" }) { const result = await api(`/api/v1/browser/tasks/${taskId}/product-proposal`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), ...input }) }); const flow = await ensureFlow(taskId); await saveFlow({ ...flow, phase: "product_review_required", retries: 0, message: "Review this exact product before checkout" }); return result; }
async function confirmProposal(taskId: string, proposalId: string, productUrl: string) { const result = await api(`/api/v1/browser/tasks/${taskId}/product-proposals/${proposalId}/confirm`, { method: "POST", body: JSON.stringify({ installationId: await installationId() }) }); const flow = await ensureFlow(taskId); if (new URL((await chrome.tabs.get(flow.tabId)).url ?? "about:blank").href !== productUrl) await chrome.tabs.update(flow.tabId, { url: productUrl, active: true }); await report(taskId, "navigating", "Product confirmed. Opening protected checkout."); await saveFlow({ ...flow, phase: "selection_confirmed", retries: 0, message: "Product confirmed. Opening checkout" }); schedule(taskId, 700); return result; }
async function dismissProposal(taskId: string, proposalId: string) { const result = await api(`/api/v1/browser/tasks/${taskId}/product-proposals/${proposalId}/dismiss`, { method: "POST", body: JSON.stringify({ installationId: await installationId() }) }); const flow = await ensureFlow(taskId); await saveFlow({ ...flow, phase: "selection_required", retries: 0, message: "Keep browsing—SpendSeal will notice another product" }); return result; }

async function changeProduct(taskId: string) {
  const flow = await ensureFlow(taskId);
  const result = await api(`/api/v1/browser/tasks/${taskId}/reselect-product`, { method: "POST", body: JSON.stringify({ installationId: await installationId() }) });
  await chrome.storage.local.remove("executionGrant");
  const target = shoppingSearchUrl(result.task);
  await chrome.tabs.update(flow.tabId, { url: target, active: true });
  await saveFlow({ ...flow, phase: "searching", retries: 0, message: "Previous checkout cancelled. Choose another product" });
  return result;
}

async function choosePayment(taskId: string, paymentPreference: "cash_on_delivery" | "online") {
  const flow = await ensureFlow(taskId);
  const result = await api(`/api/v1/browser/tasks/${taskId}/payment-preference`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), paymentPreference }) });
  const selected = await commandTab(flow.tabId, "choosePayment", { paymentPreference });
  if (!selected.selected) {
    await report(taskId, "user_action_required", selected.detail ?? selected.reason);
    await saveFlow({ ...flow, phase: "user_action_required", message: selected.detail ?? "Payment option needs your attention" });
    return selected;
  }
  if (paymentPreference === "online") {
    await report(taskId, "payment_action_required", selected.detail);
    await saveFlow({ ...flow, phase: "payment_action_required", retries: 0, message: "Choose UPI, card or netbanking on the website" });
    return { ...result, ...selected };
  }
  await report(taskId, "checkout_configuring", "Cash on Delivery selected. Opening final review.");
  await saveFlow({ ...flow, phase: "checkout_configuring", retries: 0, message: "Cash on Delivery selected" });
  schedule(taskId, 1000);
  return { ...result, ...selected };
}

async function advance(taskId: string, userInitiated = false): Promise<any> {
  if (running.has(taskId)) return { running: true };
  running.add(taskId);
  try {
    const details = await api(`/api/v1/browser/tasks/${taskId}`); const task = details.task; const flow = await ensureFlow(taskId);
    if (["prepared", "completed", "denied", "failed", "expired", "reconciliation_required"].includes(task.status)) return { task };
    if (task.status === "pending_approval") return userInitiated ? approveAndContinue(taskId) : openApproval(taskId);
    if (task.status === "approved") return revalidate(taskId);
    if (task.status === "submitting") return finalize(taskId);
    if (task.status === "payment_choice_required" && !task.paymentPreference) return { task };
    if (["selection_required", "product_review_required"].includes(task.status)) return { task };
    if (task.status === "selection_confirmed") { await report(taskId, "navigating", "Opening checkout for the confirmed product."); schedule(taskId, 300); return { task }; }
    if (task.status === "searching" && !task.selectedCandidateId) return inspect(taskId);
    if (task.status === "navigating" && task.selectedCandidateId && flow.phase !== "checkout_configuring") {
      await saveFlow({ ...flow, phase: "opening_buy_now", message: "Opening checkout" });
      const opened = await commandTab(flow.tabId, "buyNow");
      if (!opened.clicked) return retryOrPause(taskId, flow, opened.detail ?? "The exact Buy Now control was not ready.");
      await report(taskId, "checkout_configuring", "Buy Now activated. Using the saved address and default delivery.");
      await saveFlow({ ...flow, phase: "checkout_configuring", retries: 0, message: "Using saved address and default delivery" });
      schedule(taskId, 1200); return opened;
    }
    if (["checkout_configuring", "payment_choice_required", "payment_action_required", "user_action_required"].includes(task.status)) {
      if (task.status === "user_action_required" && !userInitiated) return { task };
      if (task.status === "user_action_required") await report(taskId, "checkout_configuring", "Resuming the visible checkout after user action.");
      const fxQuote = task.site === "openai_api" ? await getFxQuote(taskId) : null;
      const configured = await commandTab(flow.tabId, "configureCheckout", { paymentPreference: task.paymentPreference, fxQuote });
      if (configured.userActionRequired) {
        await report(taskId, "user_action_required", configured.reason);
        await saveFlow({ ...flow, phase: "user_action_required", message: configured.reason }); return configured;
      }
      if (configured.paymentChoiceRequired) {
        await report(taskId, "payment_choice_required", "Choose Cash on Delivery or Online payment.");
        await saveFlow({ ...flow, phase: "payment_choice_required", retries: 0, message: "Waiting for payment choice" }); return configured;
      }
      if (configured.paymentActionRequired) {
        await report(taskId, "payment_action_required", configured.reason);
        await saveFlow({ ...flow, phase: "payment_action_required", message: configured.reason }); return configured;
      }
      if (configured.advanced) {
        await saveFlow({ ...flow, phase: "checkout_configuring", retries: 0, message: configured.detail ?? "Configuring checkout" });
        schedule(taskId, 1200); return configured;
      }
      if (configured.kind === "checkout" && configured.finalReview) {
        await saveFlow({ ...flow, phase: "protecting_checkout", retries: 0, message: "Protecting the exact final checkout" });
        const observed = await api(`/api/v1/browser/tasks/${taskId}/checkout-observation`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), observation: configured.observation }) });
        if (!observed.allowed) return observed;
        await saveFlow({ ...flow, phase: "pending_approval", message: "Waiting for one passkey confirmation" });
        return openApproval(taskId);
      }
      return retryOrPause(taskId, flow, configured.detail ?? "The final checkout is not ready yet.");
    }
    return { task };
  } finally { running.delete(taskId); notify(); }
}

async function openApproval(taskId: string) {
  const flow = await ensureFlow(taskId);
  if (flow.phase === "approval_window_open") return { waitingForApproval: true };
  await saveFlow({ ...flow, phase: "approval_window_open", message: "Confirm the protected order with your passkey" });
  return approveAndContinue(taskId);
}

async function approveAndContinue(taskId: string) {
  const flow = await ensureFlow(taskId); const stateValue = base64url(crypto.getRandomValues(new Uint8Array(32))); const redirectUri = chrome.identity.getRedirectURL("shopping-approval");
  const continuation = await api(`/api/v1/browser/tasks/${taskId}/approval-continuation`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), redirectUri, state: stateValue }) });
  const callback = await chrome.identity.launchWebAuthFlow({ url: continuation.authorizeUrl, interactive: true });
  if (!callback) { await saveFlow({ ...flow, phase: "pending_approval", message: "Passkey confirmation is still required" }); return { cancelled: true }; }
  const returned = new URL(callback);
  if (returned.searchParams.get("state") !== stateValue || returned.searchParams.get("task_id") !== taskId) throw new Error("The secure approval return did not match this Shopping Task.");
  if (returned.searchParams.get("result") === "cancelled") {
    await chrome.storage.local.remove("executionGrant");
    const details = await api(`/api/v1/browser/tasks/${taskId}`);
    await chrome.tabs.update(flow.tabId, { url: shoppingSearchUrl(details.task), active: true });
    await saveFlow({ ...flow, phase: "searching", retries: 0, message: "Previous checkout cancelled. Choose another product" });
    return { cancelled: true, task: details.task };
  }
  if (returned.searchParams.get("result") !== "approved") throw new Error("The secure approval return did not approve this Shopping Task.");
  await saveFlow({ ...flow, phase: "revalidating", retries: 0, message: "Protection check running" });
  return revalidate(taskId);
}

async function revalidate(taskId: string) {
  const details = await api(`/api/v1/browser/tasks/${taskId}`); const flow = await ensureFlow(taskId);
  const fxQuote = details.task.site === "openai_api" ? await getFxQuote(taskId) : null;
  const observed = await commandTab(flow.tabId, "inspect", { paymentPreference: details.task.paymentPreference, fxQuote });
  if (observed.kind !== "checkout") throw new Error("Keep the final checkout page visible for the protection re-check.");
  const claim = await api(`/api/v1/browser/tasks/${taskId}/execution-claim`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), observation: observed.observation }) });
  if (claim.status !== "submitting") {
    await saveFlow({ ...flow, phase: claim.status, message: claim.status === "prepared" ? "PURCHASE_PREPARED — no live order submitted" : `Blocked: ${claim.reason ?? "checkout changed"}` });
    return claim;
  }
  const livePurchaseEnabled = (await chrome.storage.local.get(["livePurchaseEnabled"])).livePurchaseEnabled === true;
  const submission = await commandTab(flow.tabId, "submitLive", { livePurchaseEnabled, executionGrant: claim.executionGrant, paymentPreference: claim.paymentPreference });
  if (!submission.submitted) return reportExecution(taskId, claim.executionGrant, "failed", submission.detail ?? submission.reason);
  await chrome.storage.local.set({ executionGrant: claim.executionGrant });
  await saveFlow({ ...flow, phase: "submitting", message: claim.paymentPreference === "cash_on_delivery" ? "Placing Cash on Delivery order" : "Continuing to secure online payment" });
  schedule(taskId, 1200);
  return { ...claim, submissionStarted: true };
}

async function finalize(taskId: string) {
  const stored = await chrome.storage.local.get(["executionGrant"]); if (!stored.executionGrant) throw new Error("No active execution grant.");
  const flow = await ensureFlow(taskId); const outcome = await commandTab(flow.tabId, "executionOutcome");
  const result = await reportExecution(taskId, stored.executionGrant, outcome.status, outcome.detail);
  await chrome.storage.local.remove("executionGrant");
  await saveFlow({ ...flow, phase: result.status, message: result.status === "completed" ? "Order completed" : result.status.replaceAll("_", " ") });
  return result;
}

async function retryOrPause(taskId: string, flow: Flow, detail: string) {
  if (flow.retries < 3) { await saveFlow({ ...flow, retries: flow.retries + 1, message: detail }); schedule(taskId, 1200); return { retrying: true }; }
  await report(taskId, "user_action_required", detail); await saveFlow({ ...flow, phase: "user_action_required", message: detail }); return { userActionRequired: true, reason: detail };
}
function schedule(taskId: string, delay: number) { setTimeout(() => { void advance(taskId); }, delay); }
async function detectManualProduct(flow: Flow, tabId = flow.tabId, knownUrl?: string) {
  if (manualProductDetections.has(flow.taskId)) return { detecting: true };
  manualProductDetections.add(flow.taskId);
  try {
    const details = await api(`/api/v1/browser/tasks/${flow.taskId}`);
    if (["submitting", "prepared", "completed", "denied", "failed", "expired", "reconciliation_required"].includes(details.task.status)) return { ignored: true };
    const tab = knownUrl ? { url: knownUrl } : await chrome.tabs.get(tabId).catch(() => null);
    const tabUrl = tab?.url;
    if (!tabUrl || !isProductUrlForTask(details.task.site, tabUrl)) return { ignored: true };
    const observed = await commandTab(tabId, "inspectProduct", { site: details.task.site, query: details.task.query, maxTotalPaise: details.task.maxTotalPaise });
    if (observed.kind !== "product") return { ignored: true };
    const proposed = details.proposal && details.candidates?.find((candidate: any) => candidate.id === details.proposal.candidateId);
    if (tabId !== flow.tabId) {
      flow = { ...flow, tabId, phase: "manual_product_opened", retries: 0, message: "Review the product you opened" };
      await saveFlow(flow);
    }
    if (proposed?.canonicalProductId === observed.candidate.canonicalProductId) return { unchanged: true };
    const result = await propose(flow.taskId, { candidate: observed.candidate, source: "manual" });
    await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
    return result;
  } finally {
    manualProductDetections.delete(flow.taskId);
  }
}
function isProductUrlForTask(site: string, rawUrl: string) {
  if (site !== "amazon_in" && site !== "flipkart_in") return false;
  return isProductUrlForSite(site as AdapterSite, rawUrl);
}
async function observeVisiblePage(flow: Flow) { const snapshot = await commandTab(flow.tabId, "redactedSnapshot"); if (snapshot.kind !== "redacted_page") return; await api(`/api/v1/browser/tasks/${flow.taskId}/redacted-page`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), snapshot: snapshot.snapshot }) }); }
async function pollOperator() { const flow = await currentFlow(); if (!flow) return; const response = await api(`/api/v1/browser/tasks/${flow.taskId}/operator-command?installationId=${encodeURIComponent(await installationId())}`).catch(() => null); if (!response?.command) return; const command = response.command; let status: "completed" | "blocked" | "failed" = "completed"; let result: any; try { if (command.action.type === "navigate") { await chrome.tabs.update(flow.tabId, { url: command.action.url, active: true }); result = { navigated: true }; } else result = await commandTab(flow.tabId, "operatorAction", { operatorAction: command.action }); if (result?.blocked) status = "blocked"; else if (result?.error) status = "failed"; } catch (error) { status = "failed"; result = { error: error instanceof Error ? error.message : "Operator action failed" }; } const snapshotResult = await commandTab(flow.tabId, "redactedSnapshot").catch(() => null); await api(`/api/v1/browser/tasks/${flow.taskId}/operator-commands/${command.id}/result`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), status, result, snapshot: snapshotResult?.snapshot }) }); notify(); }
async function getFxQuote(taskId: string) { return api(`/api/v1/browser/tasks/${taskId}/fx-quote`).then((value) => value.fxQuote); }
async function reportExecution(taskId: string, executionGrant: string, status: string, detail?: string) { return api(`/api/v1/browser/tasks/${taskId}/execution-result`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), executionGrant, status, detail }) }); }
async function disconnect() { const stored = await chrome.storage.local.get(["tokens", "installationId"]); if (stored.installationId && stored.tokens) await api(`/api/v1/browser/installations/${stored.installationId}`, { method: "DELETE" }).catch(() => undefined); if (stored.tokens?.refresh_token) await fetch(`${API}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: stored.tokens.refresh_token }) }).catch(() => undefined); await chrome.storage.local.clear(); }
async function report(taskId: string, status: string, detail?: string) { return api(`/api/v1/browser/tasks/${taskId}/status`, { method: "POST", body: JSON.stringify({ installationId: await installationId(), status, detail }) }); }
async function api(path: string, init: RequestInit = {}) { let tokens = (await chrome.storage.local.get(["tokens"])).tokens; if (!tokens) throw new Error("Connect the extension first."); let response = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}`, ...(init.headers ?? {}) } }); if (response.status === 401 && tokens.refresh_token) { tokens = await refresh(tokens.refresh_token); response = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}`, ...(init.headers ?? {}) } }); } const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error?.message ?? data.error?.code ?? `SpendSeal returned ${response.status}`); return data; }
async function refresh(refreshToken: string) { const response = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID, resource: API }) }); if (!response.ok) { await chrome.storage.local.remove("tokens"); throw new Error("Reconnect the extension."); } const tokens = await response.json(); await chrome.storage.local.set({ tokens }); return tokens; }
async function commandTab(tabId: number, action: string, extra: any = {}) { try { return await chrome.tabs.sendMessage(tabId, { action, ...extra }); } catch { try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); return chrome.tabs.sendMessage(tabId, { action, ...extra }); } catch (error) { const message = error instanceof Error ? error.message : String(error); if (/cannot access contents|must request permission|missing host permission/i.test(message)) throw new Error("Website permission is missing. Return to SpendSeal and click Start protected search to allow this exact site."); throw error; } } }
async function ensureFlow(taskId: string): Promise<Flow> { const existing = await currentFlow(); if (existing?.taskId === taskId) return existing; const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) throw new Error("No active shopping tab."); const flow = { taskId, tabId: tab.id, phase: "unknown", retries: 0, message: "Resuming protected checkout" }; await saveFlow(flow); return flow; }
async function currentFlow(): Promise<Flow | null> { return (await chrome.storage.local.get(["flow"])).flow ?? null; }
async function saveFlow(flow: Flow) { await chrome.storage.local.set({ flow, activeTaskId: flow.taskId }); notify(); }
function notify() { void chrome.runtime.sendMessage({ type: "flowUpdated" }).catch(() => undefined); }
async function installationId() { const value = (await chrome.storage.local.get(["installationId"])).installationId; if (!value) throw new Error("Extension is not registered."); return value; }
function shoppingStartUrl(task: any) { return task.productUrl ?? (task.site === "amazon_in" ? `https://www.amazon.in/s?k=${encodeURIComponent(task.query ?? "")}` : task.site === "flipkart_in" ? `https://www.flipkart.com/search?q=${encodeURIComponent(task.query ?? "")}` : task.allowedOrigin); }
function shoppingSearchUrl(task: any) { return task.site === "amazon_in" ? `https://www.amazon.in/s?k=${encodeURIComponent(task.query ?? "")}` : task.site === "flipkart_in" ? `https://www.flipkart.com/search?q=${encodeURIComponent(task.query ?? "")}` : task.allowedOrigin; }
function base64url(bytes: Uint8Array) { let binary = ""; bytes.forEach((byte) => binary += String.fromCharCode(byte)); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
