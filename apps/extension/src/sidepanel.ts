declare const chrome: any;
const connection = byId("connection"); const tasks = byId("tasks"); const taskList = byId("task-list"); const active = byId("active"); const detail = byId("task-detail"); const actions = byId("actions"); const notice = byId("notice");
const rankingByProduct = new Map<string, any>(); let activeTaskId: string | null = null; let timer: number | null = null; let refreshInFlight = false; let lastRenderKey = "";
byId("connect").onclick = () => act({ type: "connect" }, load);
byId("refresh").onclick = loadTasks;
byId("back").onclick = () => { activeTaskId = null; active.hidden = true; tasks.hidden = false; void loadTasks(); };
chrome.runtime.onMessage.addListener((message: any) => { if (message.type === "flowUpdated") void refreshActive(); });
void load();

async function load() {
  const state = await send({ type: "state" }); if (state.error) return show(state.error, true);
  connection.hidden = state.connected; tasks.hidden = !state.connected; if (state.connected) await loadTasks();
  if (timer === null) timer = window.setInterval(() => { activeTaskId ? void refreshActive() : void loadTasks(); }, 6000);
}
async function loadTasks() {
  const result = await send({ type: "pending" }); if (result.error) return show(result.error, true); taskList.innerHTML = "";
  if (!result.tasks?.length) taskList.innerHTML = `<div class="task"><b>No pending tasks</b><div class="meta">Ask ChatGPT to create a SpendSeal Shopping Task.</div></div>`;
  for (const task of result.tasks ?? []) {
    const element = document.createElement("article"); element.className = "task";
    element.innerHTML = `<b>${escapeHtml(task.query ?? "Exact product link")}</b><div class="meta">${siteName(task.site)} · maximum ${rupees(task.maxTotalPaise)}</div><span class="status">${pretty(task.status)}</span><button>Open task</button>`;
    element.querySelector("button")!.addEventListener("click", () => openTask(task)); taskList.append(element);
  }
}
async function openTask(task: any) {
  activeTaskId = task.id; lastRenderKey = ""; tasks.hidden = true; active.hidden = false; render(task, []);
  if (["waiting_for_extension", "created"].includes(task.status)) await startTask(task);
  await refreshActive();
}
async function refreshActive() {
  if (!activeTaskId || refreshInFlight) return;
  refreshInFlight = true;
  try { const details = await fetchTask(activeTaskId); if (details?.task) render(details.task, details.candidates ?? [], details.proposal ?? null); }
  finally { refreshInFlight = false; }
}
async function fetchTask(taskId: string) { const result = await send({ type: "task", taskId }); return result.error ? null : result; }
async function loadCandidates(taskId: string) { const result = await fetchTask(taskId); return result?.candidates ?? []; }

function render(task: any, candidates: any[], proposal: any = null) {
  activeTaskId = task.id;
  const renderKey = JSON.stringify([task.id, task.status, task.updatedAt, task.mode, task.paymentPreference, proposal?.id, proposal?.status, ...candidates.map((candidate) => [candidate.id, candidate.snapshotHash, candidate.selected])]);
  if (renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;
  detail.innerHTML = `<article class="seal"><span class="status">${pretty(task.status)}</span><h2>${escapeHtml(task.query ?? "Exact product")}</h2><div class="meta">Protected maximum: ${rupees(task.maxTotalPaise)} · quantity 1 · no substitutions or add-ons</div><div class="progress"><i></i><span>${progressMessage(task.status)}</span></div></article>`;
  actions.innerHTML = "";
  if (task.mode === "prepare_only") { const safety = document.createElement("article"); safety.className = "task"; safety.innerHTML = `<b>Demo safety is on</b><div class="meta">SpendSeal will verify this checkout, but this task was created while the deployment-wide live-order kill switch was off.</div>`; actions.append(safety); }
  if (["waiting_for_extension", "created"].includes(task.status)) addAction("Start protected search", () => startTask(task));
  if (task.status === "searching") addAction("Read matching products", async () => { const result = await send({ type: "inspect", taskId: task.id }); if (result.error) return show(result.error, true); if (result.candidates) { rankingByProduct.clear(); for (const item of result.ranking ?? []) rankingByProduct.set(item.canonicalProductId, item); task.status = "selection_required"; render(task, result.candidates); } });
  if (task.status === "selection_required") {
    const explanation = document.createElement("p"); explanation.className = "ranking-note"; explanation.textContent = "Recommended matches—not automatic choices. Review one below, or browse any other product on this website and SpendSeal will update itself."; actions.append(explanation);
    for (const [index, candidate] of candidates.entries()) {
      const ranking = rankingByProduct.get(candidate.canonicalProductId); const quality = ranking?.rating ? ` · ${ranking.rating}/5${ranking.reviewCount ? ` (${Number(ranking.reviewCount).toLocaleString("en-IN")} reviews)` : ""}` : "";
      const reasons = (candidate.rankingReasons ?? ranking?.reasons ?? []).map((reason: string) => `<li>${escapeHtml(reason)}</li>`).join("");
      const card = document.createElement("article"); card.className = "candidate"; card.innerHTML = `<span class="rank">RECOMMENDED MATCH #${index + 1}</span><div class="candidate-media">${candidate.imageUrl ? `<img src="${escapeHtml(candidate.imageUrl)}" alt="">` : ""}<div><b>${escapeHtml(candidate.title)}</b><div class="meta">${rupees(candidate.pricePaise)}${quality} · ${escapeHtml(candidate.seller ?? "seller shown on product page")}</div>${reasons ? `<ul>${reasons}</ul>` : ""}</div></div><button>Review this product</button>`;
      card.querySelector("button")!.addEventListener("click", () => act({ type: "propose", taskId: task.id, candidateId: candidate.id }, (result) => { render(result.task, [result.candidate], result.proposal); show("Take your time. Checkout will not start until you choose “Use this product”."); })); actions.append(card);
    }
  }
  if (task.status === "product_review_required" && proposal) {
    const candidate = candidates.find((item) => item.id === proposal.candidateId);
    if (candidate) {
      const reasons = (candidate.rankingReasons ?? []).map((reason: string) => `<li>${escapeHtml(reason)}</li>`).join(""); const card = document.createElement("article"); card.className = `candidate${proposal.warning ? " warning" : ""}`;
      card.innerHTML = `<span class="rank">${candidate.proposalSource === "manual" ? "YOU OPENED THIS PRODUCT" : "PRODUCT REVIEW"}</span><div class="candidate-media">${candidate.imageUrl ? `<img src="${escapeHtml(candidate.imageUrl)}" alt="">` : ""}<div><b>${escapeHtml(candidate.title)}</b><div class="meta">${rupees(candidate.pricePaise)} · ${escapeHtml(candidate.seller ?? "seller shown at checkout")}${candidate.variant ? ` · ${escapeHtml(candidate.variant)}` : ""}</div>${reasons ? `<ul>${reasons}</ul>` : ""}</div></div>${proposal.warning ? `<p>${escapeHtml(proposal.warning)}</p>` : ""}<p>SpendSeal is waiting. Nothing will be added or purchased until you confirm.</p><div class="review-actions"><button class="secondary" data-action="browse">Keep browsing</button><button data-action="confirm" ${candidate.pricePaise > task.maxTotalPaise ? "disabled" : ""}>Use this product</button></div>`;
      card.querySelector("[data-action='browse']")!.addEventListener("click", () => act({ type: "dismissProposal", taskId: task.id, proposalId: proposal.id }, (result) => { render(result.task, candidates, null); show("Keep browsing. SpendSeal will notice the next product page you open."); }));
      card.querySelector("[data-action='confirm']")!.addEventListener("click", () => act({ type: "confirmProposal", taskId: task.id, proposalId: proposal.id, productUrl: candidate.productUrl }, (result) => { render(result.task, [], null); show("Product confirmed. SpendSeal is now preparing checkout."); })); actions.append(card);
    }
  }
  if (task.status === "payment_choice_required") {
    const card = document.createElement("article"); card.className = "choice"; card.innerHTML = `<b>How would you like to pay?</b><p>SpendSeal will protect this choice and the complete final total.</p>`;
    const cod = document.createElement("button"); cod.textContent = "Cash on Delivery"; cod.onclick = () => void act({ type: "choosePayment", taskId: task.id, paymentPreference: "cash_on_delivery" }, () => show("Cash on Delivery selected. No bank prompt will appear."));
    const online = document.createElement("button"); online.textContent = "Online payment"; online.className = "secondary"; online.onclick = () => void act({ type: "choosePayment", taskId: task.id, paymentPreference: "online" }, () => show("Choose UPI, card or netbanking on the website. SpendSeal will not read the details."));
    card.append(cod, online); actions.append(card);
  }
  if (task.status === "payment_action_required") { const box = document.createElement("article"); box.className = "task"; box.innerHTML = `<b>Choose your online method on the website</b><div class="meta">Choose UPI, card or netbanking there. SpendSeal sees only the masked method type—not your account or card details.</div>`; actions.append(box); addAction("Continue after choosing payment", () => act({ type: "resume", taskId: task.id }, () => show("Reading the protected final checkout."))); }
  if (task.status === "pending_approval") addAction("Review and confirm protected order", () => act({ type: "approveAndContinue", taskId: task.id }, (result) => { if (!result.cancelled) show("Approved. SpendSeal is re-checking every protected detail."); }));
  if (task.status === "user_action_required") { const box = document.createElement("article"); box.className = "task danger"; box.innerHTML = `<b>Your action is needed on the website</b><div class="meta">Complete login, address, CAPTCHA, OTP, or the visible website step. SpendSeal never bypasses it.</div>`; actions.append(box); addAction("Resume protected checkout", () => act({ type: "resume", taskId: task.id }, () => show("Resuming safely."))); }
  if (task.status === "prepared") show("PURCHASE_PREPARED — protection passed and no live order was submitted.");
  if (["selection_confirmed", "navigating", "checkout_configuring", "payment_choice_required", "payment_action_required", "pending_approval", "approved", "user_action_required", "denied", "failed"].includes(task.status)) {
    const button = document.createElement("button"); button.className = "secondary"; button.textContent = "← Choose another product";
    button.onclick = () => void act({ type: "changeProduct", taskId: task.id }, (result) => { render(result.task, [], null); show("Previous checkout and approval cancelled. Choose another product."); });
    actions.append(button);
  }
  if (["checkout_configuring", "navigating", "approved"].includes(task.status)) addTroubleshooting(task.id);
}
function addTroubleshooting(taskId: string) { const box = document.createElement("details"); box.className = "troubleshooting"; box.innerHTML = `<summary>Troubleshooting</summary><p>Use this only if the website stopped changing.</p>`; const button = document.createElement("button"); button.className = "quiet"; button.textContent = "Retry current step"; button.onclick = () => void act({ type: "retry", taskId }, () => show("Retrying the current visible step.")); box.append(button); actions.append(box); }
async function startTask(task: any) {
  const target = task.productUrl ?? (task.site === "amazon_in" ? `https://www.amazon.in/s?k=${encodeURIComponent(task.query ?? "")}` : task.site === "flipkart_in" ? `https://www.flipkart.com/search?q=${encodeURIComponent(task.query ?? "")}` : task.allowedOrigin);
  if (!target) return show("This task has no permitted website.", true);
  const permissionOrigin = new URL(target).origin; const granted = await chrome.permissions.request({ origins: [`${permissionOrigin}/*`] });
  if (!granted) return show("Chrome needs your permission for this exact website before SpendSeal can continue.", true);
  show("Permission granted. Opening the protected shopping tab.");
  const result = await send({ type: "openTask", task, permissionOrigin });
  if (result.error) return show(result.error, true);
  show("Protected shopping tab opened. SpendSeal is finding matching products.");
}
function progressMessage(status: string) { const messages: Record<string, string> = { waiting_for_extension: "Waiting for the extension", searching: "Reading visible product matches", selection_required: "Review a recommendation or browse another product", product_review_required: "Waiting for your product review", selection_confirmed: "Product confirmed", operator_navigating: "ChatGPT is navigating the permitted website", navigating: "Opening the exact product", checkout_configuring: "Using saved address and default delivery", payment_choice_required: "Waiting for payment choice", payment_action_required: "Waiting for your online method", pending_approval: "Waiting for final passkey confirmation", approved: "Protection check running", submitting: "Submitting exactly once", prepared: "Protected checkout prepared", completed: "Order confirmed", user_action_required: "Paused safely for you" }; return messages[status] ?? pretty(status); }
function addAction(label: string, handler: () => unknown) { const button = document.createElement("button"); button.textContent = label; button.onclick = () => void handler(); actions.append(button); }
async function act(message: any, done: (value: any) => unknown) { const result = await send(message); if (result.error) show(result.error, true); else await done(result); }
function send(message: any): Promise<any> { return chrome.runtime.sendMessage(message); }
function show(message: string, error = false) { notice.hidden = false; notice.className = error ? "task danger" : "task success"; notice.textContent = message; }
function byId(id: string) { return document.getElementById(id)!; }
function rupees(paise: number) { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: Math.abs(paise) % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(paise / 100); }
function siteName(site: string) { return site === "amazon_in" ? "Amazon India" : site === "flipkart_in" ? "Flipkart" : site === "openai_api" ? "OpenAI API billing" : "Permitted website"; }
function pretty(value: string) { return value.replaceAll("_", " "); }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
