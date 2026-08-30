declare const chrome: any;
const connection = byId("connection"); const tasks = byId("tasks"); const taskList = byId("task-list"); const active = byId("active"); const detail = byId("task-detail"); const actions = byId("actions"); const notice = byId("notice");
const rankingByProduct = new Map<string, any>(); let activeTaskId: string | null = null; let timer: number | null = null;
byId("connect").onclick = () => act({ type: "connect" }, load);
byId("refresh").onclick = loadTasks;
byId("back").onclick = () => { activeTaskId = null; active.hidden = true; tasks.hidden = false; void loadTasks(); };
chrome.runtime.onMessage.addListener((message: any) => { if (message.type === "flowUpdated") void refreshActive(); });
void load();

async function load() {
  const state = await send({ type: "state" }); if (state.error) return show(state.error, true);
  connection.hidden = state.connected; tasks.hidden = !state.connected; if (state.connected) await loadTasks();
  if (timer === null) timer = window.setInterval(() => { activeTaskId ? void refreshActive() : void loadTasks(); }, 2000);
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
  activeTaskId = task.id; tasks.hidden = true; active.hidden = false; render(task, []);
  if (["waiting_for_extension", "created"].includes(task.status)) { const result = await send({ type: "openTask", task }); if (result.error) show(result.error, true); }
  await refreshActive();
}
async function refreshActive() {
  if (!activeTaskId) return; const result = await send({ type: "pending" }); if (result.error) return;
  const task = result.tasks?.find((item: any) => item.id === activeTaskId);
  if (task) render(task, task.status === "selection_required" ? await loadCandidates(task.id) : []);
  else { const details = await fetchTask(activeTaskId); if (details?.task) render(details.task, details.candidates ?? []); }
}
async function fetchTask(taskId: string) { const result = await send({ type: "task", taskId }); return result.error ? null : result; }
async function loadCandidates(taskId: string) { const result = await fetchTask(taskId); return result?.candidates ?? []; }

function render(task: any, candidates: any[]) {
  activeTaskId = task.id;
  detail.innerHTML = `<article class="seal"><span class="status">${pretty(task.status)}</span><h2>${escapeHtml(task.query ?? "Exact product")}</h2><div class="meta">Protected maximum: ${rupees(task.maxTotalPaise)} · quantity 1 · no substitutions or add-ons</div><div class="progress"><i></i><span>${progressMessage(task.status)}</span></div></article>`;
  actions.innerHTML = "";
  if (["waiting_for_extension", "searching"].includes(task.status)) addAction("Find matching products", async () => { const result = await send({ type: "inspect", taskId: task.id }); if (result.error) return show(result.error, true); if (result.candidates) { rankingByProduct.clear(); for (const item of result.ranking ?? []) rankingByProduct.set(item.canonicalProductId, item); task.status = "selection_required"; render(task, result.candidates); } });
  if (task.status === "selection_required") {
    const explanation = document.createElement("p"); explanation.className = "ranking-note"; explanation.textContent = "These are the three strongest visible matches. You choose the exact product; SpendSeal handles checkout after that."; actions.append(explanation);
    for (const [index, candidate] of candidates.entries()) {
      const ranking = rankingByProduct.get(candidate.canonicalProductId); const quality = ranking?.rating ? ` · ${ranking.rating}/5${ranking.reviewCount ? ` (${Number(ranking.reviewCount).toLocaleString("en-IN")} reviews)` : ""}` : "";
      const card = document.createElement("article"); card.className = "candidate"; card.innerHTML = `<span class="rank">${index === 0 ? "BEST VISIBLE MATCH" : `MATCH #${index + 1}`}</span><b>${escapeHtml(candidate.title)}</b><div class="meta">${rupees(candidate.pricePaise)}${quality} · ${escapeHtml(candidate.seller ?? "seller not stated")}</div><button>Select this exact listing</button>`;
      card.querySelector("button")!.addEventListener("click", () => act({ type: "select", taskId: task.id, candidateId: candidate.id, productUrl: candidate.productUrl }, (result) => { render(result.task, []); show("Selected. SpendSeal is opening and configuring checkout automatically."); })); actions.append(card);
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
  if (["checkout_configuring", "navigating", "approved"].includes(task.status)) addTroubleshooting(task.id);
}
function addTroubleshooting(taskId: string) { const box = document.createElement("details"); box.className = "troubleshooting"; box.innerHTML = `<summary>Troubleshooting</summary><p>Use this only if the website stopped changing.</p>`; const button = document.createElement("button"); button.className = "quiet"; button.textContent = "Retry current step"; button.onclick = () => void act({ type: "retry", taskId }, () => show("Retrying the current visible step.")); box.append(button); actions.append(box); }
function progressMessage(status: string) { const messages: Record<string, string> = { waiting_for_extension: "Waiting for the extension", searching: "Reading visible product matches", selection_required: "Waiting for your product choice", navigating: "Opening the exact product", checkout_configuring: "Using saved address and default delivery", payment_choice_required: "Waiting for payment choice", payment_action_required: "Waiting for your online method", pending_approval: "Waiting for one passkey confirmation", approved: "Protection check running", submitting: "Submitting exactly once", prepared: "Protected checkout prepared", completed: "Order confirmed", user_action_required: "Paused safely for you" }; return messages[status] ?? pretty(status); }
function addAction(label: string, handler: () => unknown) { const button = document.createElement("button"); button.textContent = label; button.onclick = () => void handler(); actions.append(button); }
async function act(message: any, done: (value: any) => unknown) { const result = await send(message); if (result.error) show(result.error, true); else await done(result); }
function send(message: any): Promise<any> { return chrome.runtime.sendMessage(message); }
function show(message: string, error = false) { notice.hidden = false; notice.className = error ? "task danger" : "task success"; notice.textContent = message; }
function byId(id: string) { return document.getElementById(id)!; }
function rupees(paise: number) { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100); }
function siteName(site: string) { return site === "amazon_in" ? "Amazon India" : "Flipkart"; }
function pretty(value: string) { return value.replaceAll("_", " "); }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
