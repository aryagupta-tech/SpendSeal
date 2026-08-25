import { AgentRailError, AgentRailService } from "./service.js";
import { AgentRailStore } from "./store.js";

export async function seedNovaDesk(store: AgentRailStore, service: AgentRailService, ownerUserId: string) {
  let merchant = (await store.listMerchants({ query: "novadesk", userId: ownerUserId })).merchants.find((value) => value.slug === "novadesk");
  if (!merchant) merchant = await store.createMerchant(ownerUserId, { slug: "novadesk", displayName: "NovaDesk (Demo)" });
  else if (!await store.requireMembership(ownerUserId, merchant.id, ["owner"])) throw new AgentRailError(409, "DEMO_MERCHANT_OWNED", "The NovaDesk demo slug belongs to another account.");
  if (!(await store.paymentConfig(merchant.id))) await service.configurePayments(merchant.id, { adapter: "mock" });
  const existing = await store.listProducts(merchant.id, undefined, 100, undefined, true);
  const products = [
    { sku: "STARTER", name: "Starter", description: "Essential focus tools for individuals.", pricePaise: 49_900, refundable: false, refundWindowDays: 0 },
    { sku: "PRO-ANNUAL", name: "Pro Annual", description: "Automation and collaboration for growing teams.", pricePaise: 99_900, refundable: true, refundWindowDays: 7 },
    { sku: "BUSINESS-ANNUAL", name: "Business Annual", description: "Governance and analytics for established teams.", pricePaise: 149_900, refundable: true, refundWindowDays: 14 },
  ];
  for (const product of products) if (!existing.products.some((value) => value.sku === product.sku)) await store.createProduct(ownerUserId, merchant.id, product);
  return { merchant, products: (await store.listProducts(merchant.id)).products };
}
