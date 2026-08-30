declare const chrome: any;
const connection = byId("connection");
const tasks = byId("tasks");
const taskList = byId("task-list");
const active = byId("active");
const detail = byId("task-detail");
const actions = byId("actions");
const notice = byId("notice");

byId("connect").onclick = () => act({ type: "connect" }, load);
byId("refresh").onclick = loadTasks;
byId("back").onclick = () => { active.hidden = true; tasks.hidden = false; void loadTasks(); };
void load();

async function load() {
  const state = await send({ type: "state" });
  if (state.error) return show(state.error, true);
  connection.hidden = state.connected;
  tasks.hidden = !state.connected;
  if (state.connected) await loadTasks();
}

async function loadTasks() {
  const result = await send({ type: "pending" });
  if (result.error) return show(result.error, true);
  taskList.innerHTML = "";
  if (!result.tasks?.length) taskList.innerHTML = `<div class="task"><b>No pending tasks</b><div class="meta">Ask ChatGPT to create a SpendSeal Shopping Task.</div></div>`;
  for (const task of result.tasks ?? []) {
    const element = document.createElement("article");
    element.className = "task";
    element.innerHTML = `<b>${escapeHtml(task.query ?? "Exact product link")}</b><div class="meta">${task.site === "amazon_in" ? "Amazon India" : "Flipkart"} · maximum ${rupees(task.maxTotalPaise)}</div><span class="status">${task.status.replaceAll("_", " ")}</span><button>Open task</button>`;
    element.querySelector("button")!.addEventListener("click", () => openTask(task));
    taskList.append(element);
  }
}

async function openTask(task: any) {
  tasks.hidden = true; active.hidden = false; render(task, []);
  if (["waiting_for_extension", "created"].includes(task.status)) {
    const result = await send({ type: "openTask", task });
    if (result.error) show(result.error, true);
  }
}

function render(task: any, candidates: any[]) {
  detail.innerHTML = `<article class="seal"><span class="status">${task.status.replaceAll("_", " ")}</span><h2>${escapeHtml(task.query ?? "Exact product")}</h2><div class="meta">Complete payable total must stay at or below ${rupees(task.maxTotalPaise)}. Quantity 1; no substitutions or add-ons.</div></article>`;
  actions.innerHTML = "";
  if (["waiting_for_extension", "searching"].includes(task.status) || (task.status === "navigating" && !task.selectedCandidateId)) {
    addAction("Inspect visible page", async () => {
      const result = await send({ type: "inspect", taskId: task.id });
      if (result.error) return show(result.error, true);
      if (result.candidates) { task.status = "selection_required"; render(task, result.candidates); }
      else if (result.task) { render(result.task, []); show("Exact checkout observed. Approve it with your passkey in SpendSeal."); }
    });
  }
  if (task.status === "selection_required") {
    for (const candidate of candidates) {
      const card = document.createElement("article"); card.className = "candidate";
      card.innerHTML = `<b>${escapeHtml(candidate.title)}</b><div class="meta">${rupees(candidate.pricePaise)} · ${escapeHtml(candidate.seller ?? "seller not stated")}</div><button>Select this exact listing</button>`;
      card.querySelector("button")!.addEventListener("click", () => act(
        { type: "select", taskId: task.id, candidateId: candidate.id, productUrl: candidate.productUrl },
        (result) => { render(result.task, []); show("Selected. SpendSeal opened the exact listing."); },
      ));
      actions.append(card);
    }
  }
  if (task.status === "navigating" && task.selectedCandidateId) {
    addAction("Open isolated Buy Now flow", () => act(
      { type: "buyNow" },
      (result) => result.clicked
        ? show("Buy Now opened. Wait for the checkout page to finish loading. Complete any login or security check, then click Inspect visible final checkout.")
        : show(result.detail ?? result.reason ?? "SpendSeal could not open Buy Now on this page.", true),
    ));
    addAction("Inspect visible final checkout", async () => {
      const result = await send({ type: "inspect", taskId: task.id });
      if (result.error) return show(result.error, true);
      if (result.userActionRequired) return show(result.reason, true);
      if (result.candidates) return show("This is still a product or search page. First open the exact listing and click Open isolated Buy Now flow. Inspect checkout only after the final checkout page appears.", true);
      if (result.task) { render(result.task, []); show("Exact checkout observed. Approve it with your passkey in SpendSeal."); }
    });
  }
  if (task.status === "pending_approval") {
    const link = document.createElement("a"); link.href = `https://spendseal.vercel.app/shopping/${task.id}`; link.target = "_blank"; link.textContent = "Approve exact Purchase Seal with passkey →"; actions.append(link);
  }
  if (task.status === "approved") addAction("Re-check and prepare purchase", () => act({ type: "revalidate", taskId: task.id }, (result) => show(result.status === "prepared" ? "PURCHASE_PREPARED — no live order was submitted." : "Execution grant created.")));
  if (task.status === "submitting") addAction("Check visible order result", () => act({ type: "finalize", taskId: task.id }, (result) => show(`Execution result: ${result.status.replaceAll("_", " ")}.`)));
  if (task.status === "prepared") show("PURCHASE_PREPARED — showcase stopped before ordering.");
}

function addAction(label: string, handler: () => unknown) { const button = document.createElement("button"); button.textContent = label; button.onclick = () => void handler(); actions.append(button); }
async function act(message: any, done: (value: any) => unknown) { const result = await send(message); if (result.error) show(result.error, true); else await done(result); }
function send(message: any): Promise<any> { return chrome.runtime.sendMessage(message); }
function show(message: string, error = false) { notice.hidden = false; notice.className = error ? "task danger" : "task success"; notice.textContent = message; }
function byId(id: string) { return document.getElementById(id)!; }
function rupees(paise: number) { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100); }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
