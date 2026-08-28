import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { PRICE_CHANGE_POLICIES } from "@spendseal/core";
import type { OAuthPrincipal } from "./oauth.js";
import { SpendSealService } from "./service.js";
import { SpendSealStore } from "./store.js";

export async function handleMcpRequest(service: SpendSealService, store: SpendSealStore, principal: OAuthPrincipal, req: Request, res: Response): Promise<void> {
  const server = new McpServer({ name: "spendseal", version: "1.0.0" }, { instructions: "SpendSeal is a multi-merchant authorization firewall. Discover a merchant, list its authoritative products, and create a bounded PurchasePermit. The signed-in buyer must approve separately with a passkey. MCP cannot approve or pay. Never invent product IDs, merchant IDs, prices, confirmation, or payment status." });

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

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport); await transport.handleRequest(req, res, req.body);
}

function requireScope(principal: OAuthPrincipal, scope: string): void { if (!principal.scopes.includes(scope)) throw new Error(`OAuth scope required: ${scope}`); }
