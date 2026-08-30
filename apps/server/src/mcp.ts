import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { BrowserOperatorActionSchema, CreateShoppingTaskInputSchema, CreateWebPurchaseTaskInputSchema, PRICE_CHANGE_POLICIES } from "@spendseal/core";
import type { OAuthPrincipal } from "./oauth.js";
import { SpendSealService } from "./service.js";
import { SpendSealStore } from "./store.js";
import { BrowserAgentService } from "./browser-agent.js";

export async function handleMcpRequest(service: SpendSealService, store: SpendSealStore, browserAgent: BrowserAgentService, principal: OAuthPrincipal, req: Request, res: Response): Promise<void> {
  const server = new McpServer({ name: "spendseal", version: "2.0.0" }, { instructions: "SpendSeal is an authorization control plane for AI purchases. ChatGPT may create tasks, compare products, and queue non-sensitive visible browser actions. It can never confirm the final product, approve a Purchase Seal, access credentials, or invoke the protected final submit action. The buyer's local extension operates one explicitly permitted website at a time." });

  server.registerTool("list_merchants", { title: "Discover SpendSeal merchants", description: "Find active merchants that publish authoritative catalogs through SpendSeal.", inputSchema: { query: z.string().max(100).optional(), cursor: z.string().uuid().optional() }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } }, async ({ query, cursor }) => {
    requireScope(principal, "catalog:read"); const result = await store.listMerchants({ query, cursor, limit: 50 });
    return { structuredContent: result, content: [{ type: "text", text: result.merchants.length ? `Found ${result.merchants.length} merchant(s).` : "No matching merchants were found." }] };
  });

  server.registerTool("list_products", { title: "List merchant products", description: "Read current products, prices, availability, and merchant-stated refund terms from one authoritative merchant catalog.", inputSchema: { merchantId: z.string().uuid(), query: z.string().max(100).optional(), cursor: z.string().uuid().optional() }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } }, async ({ merchantId, query, cursor }) => {
    requireScope(principal, "catalog:read"); const result = await store.listProducts(merchantId, query, 50, cursor);
    return { structuredContent: result, content: [{ type: "text", text: result.products.length ? `Found ${result.products.length} authoritative product(s). Prices are in paise.` : "No matching active products were found." }] };
  });

  server.registerTool("create_purchase_permit", { title: "Create a PurchasePermit", description: "Create a single-use, expiring purchase mandate for the authenticated buyer and one exact merchant product. This does not approve or pay.", inputSchema: { merchantId: z.string().uuid(), productId: z.string().uuid(), maxTotalPaise: z.number().int().positive().optional(), priceChangePolicy: z.enum(PRICE_CHANGE_POLICIES).optional(), requireRefundable: z.boolean().optional(), minimumRefundWindowDays: z.number().int().min(0).max(90).nullable().optional(), expiresInMinutes: z.number().int().min(1).max(30).optional() }, annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false } }, async (input) => {
    requireScope(principal, "intents:create"); const result = await service.createIntent(principal.userId, { merchantId: input.merchantId, productId: input.productId, maxTotalPaise: input.maxTotalPaise, priceChangePolicy: input.priceChangePolicy ?? "none", requireRefundable: input.requireRefundable ?? false, minimumRefundWindowDays: input.minimumRefundWindowDays ?? null, expiresInMinutes: input.expiresInMinutes ?? 10 });
    return { structuredContent: result, content: [{ type: "text", text: `PurchasePermit ${result.intent.id} awaits the authenticated buyer's passkey approval: ${result.approvalUrl}` }] };
  });

  server.registerTool("get_purchase_permit", { title: "Get buyer PurchasePermit", description: "Read the authenticated buyer's current mandate state.", inputSchema: { purchasePermitId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } }, async ({ purchasePermitId }) => {
    requireScope(principal, "intents:read"); const intent = await store.getIntent(purchasePermitId, principal.userId);
    if (!intent) return { isError: true, content: [{ type: "text", text: "PurchasePermit not found for the authenticated buyer." }] };
    return { structuredContent: { intent }, content: [{ type: "text", text: `PurchasePermit status: ${intent.status}. Passkey confirmation: ${intent.confirmedAt ? "recorded" : "required"}.` }] };
  });

  server.registerTool("prepare_checkout", { title: "Prepare safe checkout", description: "After the authenticated buyer approves with a passkey, atomically re-check every constraint and prepare at most one Razorpay Test Mode order.", inputSchema: { purchasePermitId: z.string().uuid() }, annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true } }, async ({ purchasePermitId }) => {
    requireScope(principal, "checkout:prepare"); const result = await service.prepareCheckout(principal.userId, purchasePermitId);
    return { structuredContent: result, content: [{ type: "text", text: result.checkoutUrl ? `${result.decision.message} Checkout: ${result.checkoutUrl}` : result.decision.message }] };
  });

  server.registerTool("get_audit_trail", { title: "Get PurchasePermit audit chain", description: "Review the authenticated buyer's decision evidence and verify that PurchasePermit's SHA-256 chain.", inputSchema: { purchasePermitId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } }, async ({ purchasePermitId }) => {
    requireScope(principal, "audit:read"); const intent = await store.getIntent(purchasePermitId, principal.userId); if (!intent) return { isError: true, content: [{ type: "text", text: "PurchasePermit not found for the authenticated buyer." }] };
    const events = await store.auditTrail("intent", purchasePermitId); const verification = await store.verifyAudit("intent", purchasePermitId);
    return { structuredContent: { events, verification }, content: [{ type: "text", text: `${events.length} event(s). PurchasePermit audit chain: ${verification.valid ? "verified" : `broken at ${verification.brokenAt}`}.` }] };
  });

  server.registerTool("create_shopping_task", {
    title: "Create an Amazon or Flipkart Shopping Task",
    description: "Ask the buyer's local SpendSeal extension to search one supported website or inspect one exact product URL under a complete payable-total limit. This cannot select, approve, or order.",
    inputSchema: {
      site: z.enum(["amazon_in", "flipkart_in"]), query: z.string().min(2).max(240).optional(), productUrl: z.string().url().max(2048).optional(),
      maxTotalPaise: z.number().int().positive(), requireRefundable: z.boolean().optional(), minimumReturnWindowDays: z.number().int().min(0).max(90).nullable().optional(), latestDeliveryDate: z.string().date().nullable().optional(), expiresInMinutes: z.number().int().min(1).max(30).optional(),
    }, annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false },
  }, async (raw) => {
    requireScope(principal, "shopping:create");
    const input = CreateShoppingTaskInputSchema.parse({ ...raw, requireRefundable: raw.requireRefundable ?? false, minimumReturnWindowDays: raw.minimumReturnWindowDays ?? null, latestDeliveryDate: raw.latestDeliveryDate ?? null, expiresInMinutes: raw.expiresInMinutes ?? 10 });
    const task = await browserAgent.createTask(principal.userId, input);
    const taskUrl = `${service.config.publicBaseUrl}/shopping/${task.id}`;
    const liveDescription = browserAgent.liveModeEnabled ? "Live submission is owner-enabled; bank challenges still require the buyer." : "Live ordering is disabled.";
    return { structuredContent: { task, taskUrl, requiresExtension: true, liveOrderEnabled: browserAgent.liveModeEnabled }, content: [{ type: "text", text: `Shopping Task ${task.id} is waiting for the buyer's SpendSeal extension. The buyer must choose a candidate and approve the exact final checkout with a passkey. ${liveDescription} Track it at ${taskUrl}` }] };
  });

  server.registerTool("create_web_purchase_task", {
    title: "Create a protected web purchase task",
    description: "Create a one-time purchase objective for one HTTPS website. The buyer must grant that domain, confirm the selected product or service, and approve the exact final transaction.",
    inputSchema: {
      siteUrl: z.string().url().max(2048), objective: z.string().min(2).max(500), maxTotalPaise: z.number().int().positive(),
      purchaseKind: z.enum(["physical_good", "api_credits", "generic_one_time"]).optional(), requireRefundable: z.boolean().optional(), minimumReturnWindowDays: z.number().int().min(0).max(90).nullable().optional(), latestDeliveryDate: z.string().date().nullable().optional(), expiresInMinutes: z.number().int().min(1).max(30).optional(),
    }, annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false },
  }, async (raw) => {
    requireScope(principal, "shopping:create"); const input = CreateWebPurchaseTaskInputSchema.parse({ ...raw, purchaseKind: raw.purchaseKind ?? "generic_one_time", requireRefundable: raw.requireRefundable ?? false, minimumReturnWindowDays: raw.minimumReturnWindowDays ?? null, latestDeliveryDate: raw.latestDeliveryDate ?? null, expiresInMinutes: raw.expiresInMinutes ?? 15 });
    const task = await browserAgent.createWebTask(principal.userId, input); const taskUrl = `${service.config.publicBaseUrl}/shopping/${task.id}`;
    return { structuredContent: { task, taskUrl, requiresExtension: true }, content: [{ type: "text", text: `Web Purchase Task ${task.id} is waiting for the buyer's local extension and per-site permission. ChatGPT may navigate, but only the buyer can confirm the selection and approve final execution. Track it at ${taskUrl}` }] };
  });

  server.registerTool("get_web_purchase_task", { title: "Get protected web purchase task", description: "Read task, proposal, candidates, and Purchase Seal state.", inputSchema: { shoppingTaskId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } }, async ({ shoppingTaskId }) => {
    requireScope(principal, "shopping:read"); const result = await browserAgent.getTask(shoppingTaskId, principal.userId);
    return { structuredContent: result, content: [{ type: "text", text: `Web Purchase Task status: ${result.task.status}. ${result.proposal ? "The buyer is reviewing a proposed selection." : "No product review is pending."}` }] };
  });

  server.registerTool("get_web_purchase_task_audit", { title: "Verify web purchase audit", description: "Read and verify the protected web task's append-only evidence chain.", inputSchema: { shoppingTaskId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } }, async ({ shoppingTaskId }) => {
    requireScope(principal, "shopping:audit"); const result = await browserAgent.audit(shoppingTaskId, principal.userId);
    return { structuredContent: result, content: [{ type: "text", text: `${result.events.length} event(s); audit chain ${result.verification.valid ? "verified" : "invalid"}.` }] };
  });

  server.registerTool("get_browser_operator_state", { title: "Read the redacted browser state", description: "Read the latest redacted visible-page structure and queued action results. Screenshots and sensitive fields are never included.", inputSchema: { shoppingTaskId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false } }, async ({ shoppingTaskId }) => {
    requireScope(principal, "shopping:read"); const result = await browserAgent.operatorState(shoppingTaskId, principal.userId);
    return { structuredContent: result, content: [{ type: "text", text: result.snapshot ? `Redacted page state contains ${result.snapshot.controls.length} visible controls.` : "The extension has not reported a visible page yet." }] };
  });

  server.registerTool("perform_browser_operator_action", { title: "Queue a safe browser action", description: "Queue one visible, non-sensitive action in the task's approved tab. SpendSeal blocks sensitive fields and protected final purchase controls.", inputSchema: { shoppingTaskId: z.string().uuid(), action: BrowserOperatorActionSchema }, annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false } }, async ({ shoppingTaskId, action }) => {
    requireScope(principal, "shopping:create"); const result = await browserAgent.queueOperatorAction(shoppingTaskId, principal.userId, action);
    return { structuredContent: result, content: [{ type: "text", text: `Browser action ${result.sequence} queued. The extension will execute it visibly if it is safe.` }] };
  });

  server.registerTool("get_shopping_task", { title: "Get Shopping Task", description: "Read the authenticated buyer's browser-shopping progress, candidates and Purchase Seal state.", inputSchema: { shoppingTaskId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } }, async ({ shoppingTaskId }) => {
    requireScope(principal, "shopping:read");
    const result = await browserAgent.getTask(shoppingTaskId, principal.userId);
    return { structuredContent: result, content: [{ type: "text", text: `Shopping Task status: ${result.task.status}. ${result.task.status === "selection_required" ? "The buyer must select one candidate in the extension." : "SpendSeal is waiting for the next buyer or extension step."}` }] };
  });

  server.registerTool("get_shopping_task_audit", { title: "Verify Shopping Task audit", description: "Read and verify the buyer-owned SHA-256 Shopping Task evidence chain.", inputSchema: { shoppingTaskId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } }, async ({ shoppingTaskId }) => {
    requireScope(principal, "shopping:audit");
    const result = await browserAgent.audit(shoppingTaskId, principal.userId);
    return { structuredContent: result, content: [{ type: "text", text: `${result.events.length} browser event(s); task chain ${result.verification.valid ? "verified" : `broken at ${result.verification.brokenAt}`}. Browser evidence is observed, not provider-verified.` }] };
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport); await transport.handleRequest(req, res, req.body);
}

function requireScope(principal: OAuthPrincipal, scope: string): void { if (!principal.scopes.includes(scope)) throw new Error(`OAuth scope required: ${scope}`); }
