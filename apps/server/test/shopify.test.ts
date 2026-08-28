import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyAdminClient, ShopifyError, normalizeShopDomain } from "../src/shopify.js";

afterEach(() => vi.unstubAllGlobals());

describe("Shopify catalog connector", () => {
  it("accepts only permanent myshopify domains", () => {
    expect(normalizeShopDomain("https://agentrail-test-store.myshopify.com/admin")).toBe("agentrail-test-store.myshopify.com");
    expect(() => normalizeShopDomain("127.0.0.1.myshopify.com.evil.example")).toThrow(ShopifyError);
  });

  it("requires read_products and INR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { shop: { name: "AgentRail Test Store", currencyCode: "INR" }, currentAppInstallation: { accessScopes: [{ handle: "read_products" }] } } }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(new ShopifyAdminClient("agentrail-test-store.myshopify.com", "shpat_test_token_123456").verify()).resolves.toMatchObject({ shopName: "AgentRail Test Store", currency: "INR" });
  });

  it("maps Shopify variants to exact paise without floating-point rounding", async () => {
    const responses = [
      { data: { productVariants: { nodes: [{ id: "gid://shopify/ProductVariant/42", title: "Default Title", sku: null, price: "999.95", updatedAt: "2026-08-28T05:00:00Z", availableForSale: true, product: { id: "gid://shopify/Product/7", title: "Security Plan", description: "Annual access", status: "ACTIVE", updatedAt: "2026-08-28T04:00:00Z" } }], pageInfo: { hasNextPage: false, endCursor: null } } } },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(new ShopifyAdminClient("agentrail-test-store.myshopify.com", "shpat_test_token_123456").products()).resolves.toEqual([expect.objectContaining({ sku: "SHOPIFY-42", name: "Security Plan", pricePaise: 99995, active: true })]);
  });
});
