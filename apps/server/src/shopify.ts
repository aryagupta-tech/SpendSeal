const SHOPIFY_API_VERSION = "2026-07";

export type ShopifyConnectionDetails = {
  shopDomain: string;
  shopName: string;
  currency: string;
};

export type ShopifyCatalogItem = {
  externalId: string;
  sku: string;
  name: string;
  description: string;
  pricePaise: number;
  active: boolean;
  externalUpdatedAt: string;
};

type GraphqlResponse<T> = { data?: T; errors?: Array<{ message?: string }> };

export class ShopifyAdminClient {
  readonly shopDomain: string;

  constructor(shopDomain: string, private readonly accessToken: string) {
    this.shopDomain = normalizeShopDomain(shopDomain);
    if (!accessToken.startsWith("shpat_") && !accessToken.startsWith("shpua_")) throw new ShopifyError("SHOPIFY_TOKEN_INVALID", "Use a Shopify Admin API access token.");
  }

  async verify(): Promise<ShopifyConnectionDetails> {
    const data = await this.query<{ shop: { name: string; currencyCode: string }; currentAppInstallation: { accessScopes: Array<{ handle: string }> } | null }>(`
      query AgentRailConnectionCheck {
        shop { name currencyCode }
        currentAppInstallation { accessScopes { handle } }
      }
    `);
    const scopes = data.currentAppInstallation?.accessScopes.map((scope) => scope.handle) ?? [];
    if (!scopes.includes("read_products")) throw new ShopifyError("SHOPIFY_SCOPE_MISSING", "The Shopify app must have the read_products Admin API scope.");
    if (data.shop.currencyCode !== "INR") throw new ShopifyError("SHOPIFY_CURRENCY_UNSUPPORTED", `This AgentRail build supports INR catalogs; the Shopify store currently uses ${data.shop.currencyCode}.`);
    return { shopDomain: this.shopDomain, shopName: data.shop.name, currency: data.shop.currencyCode };
  }

  async products(): Promise<ShopifyCatalogItem[]> {
    const items: ShopifyCatalogItem[] = [];
    let cursor: string | null = null;
    do {
      const data: {
        productVariants: {
          nodes: Array<{
            id: string; title: string; sku: string | null; price: string; updatedAt: string; availableForSale: boolean;
            product: { id: string; title: string; description: string; status: string; updatedAt: string };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } = await this.query(`
        query AgentRailProducts($cursor: String) {
          productVariants(first: 100, after: $cursor) {
            nodes {
              id title sku price updatedAt availableForSale
              product { id title description status updatedAt }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, { cursor });
      for (const variant of data.productVariants.nodes) {
        const suffix = variant.id.split("/").at(-1) ?? variant.id;
        items.push({
          externalId: variant.id,
          sku: `SHOPIFY-${suffix}`,
          name: variant.title === "Default Title" ? variant.product.title : `${variant.product.title} · ${variant.title}`,
          description: variant.product.description ?? "",
          pricePaise: decimalToPaise(variant.price),
          active: variant.product.status === "ACTIVE" && variant.availableForSale,
          externalUpdatedAt: new Date(variant.updatedAt > variant.product.updatedAt ? variant.updatedAt : variant.product.updatedAt).toISOString(),
        });
      }
      if (items.length > 5_000) throw new ShopifyError("SHOPIFY_CATALOG_TOO_LARGE", "The first release supports at most 5,000 Shopify variants per merchant.");
      cursor = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
    } while (cursor);
    return items;
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://${this.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-access-token": this.accessToken },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ShopifyError("SHOPIFY_UNREACHABLE", "Shopify could not be reached. Try again after checking your network.");
    }
    if (response.status === 401 || response.status === 403) throw new ShopifyError("SHOPIFY_CREDENTIALS_INVALID", "Shopify rejected the store domain or Admin API token.");
    if (!response.ok) throw new ShopifyError("SHOPIFY_REQUEST_FAILED", `Shopify returned HTTP ${response.status}.`);
    const body = await response.json() as GraphqlResponse<T>;
    if (body.errors?.length || !body.data) throw new ShopifyError("SHOPIFY_GRAPHQL_ERROR", body.errors?.[0]?.message ?? "Shopify returned an invalid response.");
    return body.data;
  }
}

export class ShopifyError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function normalizeShopDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized)) throw new ShopifyError("SHOPIFY_DOMAIN_INVALID", "Enter the permanent store domain, for example store-name.myshopify.com.");
  return normalized;
}

function decimalToPaise(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new ShopifyError("SHOPIFY_PRICE_INVALID", "Shopify returned a price that cannot be represented in paise.");
  const [rupees, fraction = ""] = value.split(".");
  const paise = Number(rupees) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(paise) || paise <= 0) throw new ShopifyError("SHOPIFY_PRICE_INVALID", "Shopify returned a non-positive or unsupported price.");
  return paise;
}
