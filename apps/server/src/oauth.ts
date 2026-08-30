import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { BROWSER_SCOPES, MCP_SCOPES, sha256 } from "@spendseal/core";
import type { Config } from "./config.js";
import { transaction } from "./db/client.js";
import { SpendSealError } from "./service.js";
import { SpendSealStore } from "./store.js";

export type OAuthPrincipal = { userId: string; clientId: string; scopes: string[]; resource: string };

export class OAuthService {
  constructor(readonly store: SpendSealStore, readonly config: Config) {}

  protectedResourceMetadata() {
    return { resource: this.config.publicBaseUrl, authorization_servers: [this.config.oauthIssuer], scopes_supported: [...MCP_SCOPES, ...BROWSER_SCOPES], resource_documentation: `${this.config.publicBaseUrl}/docs/oauth` };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.config.oauthIssuer,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${this.config.oauthIssuer}/oauth/authorize`,
      token_endpoint: `${this.config.oauthIssuer}/oauth/token`,
      revocation_endpoint: `${this.config.oauthIssuer}/oauth/revoke`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      scopes_supported: [...MCP_SCOPES, ...BROWSER_SCOPES],
    };
  }

  validateAuthorizationRequest(input: Record<string, string | undefined>) {
    if (input.response_type !== "code") throw new SpendSealError(400, "unsupported_response_type", "Only authorization code flow is supported.");
    if (!input.client_id || !this.allowedClientId(input.client_id)) throw new SpendSealError(400, "invalid_client", "The OAuth client is not allowed.");
    if (!input.redirect_uri || !this.allowedRedirect(input.client_id, input.redirect_uri)) throw new SpendSealError(400, "invalid_redirect_uri", "The redirect URI is not allowed.");
    if (!input.resource || input.resource !== this.config.publicBaseUrl) throw new SpendSealError(400, "invalid_target", "The OAuth resource must exactly match SpendSeal.");
    if (!input.code_challenge || input.code_challenge_method !== "S256") throw new SpendSealError(400, "invalid_request", "S256 PKCE is required.");
    const scopes = [...new Set((input.scope ?? "").split(/\s+/).filter(Boolean))];
    const allowedScopes = input.client_id === this.config.extensionOauthClientId ? BROWSER_SCOPES : MCP_SCOPES;
    if (!scopes.length || scopes.some((scope) => !(allowedScopes as readonly string[]).includes(scope))) throw new SpendSealError(400, "invalid_scope", "One or more requested scopes are unsupported for this client.");
    return { clientId: input.client_id, redirectUri: input.redirect_uri, resource: input.resource, codeChallenge: input.code_challenge, scopes, state: input.state ?? "" };
  }

  async authorize(userId: string, input: ReturnType<OAuthService["validateAuthorizationRequest"]>): Promise<string> {
    const code = randomBytes(32).toString("base64url");
    await this.store.pool.query(`INSERT INTO oauth_authorization_codes(code_hash,user_id,client_id,redirect_uri,resource,scopes_json,code_challenge,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')`, [sha256(code), userId, input.clientId, input.redirectUri, input.resource, JSON.stringify(input.scopes), input.codeChallenge]);
    const redirect = new URL(input.redirectUri); redirect.searchParams.set("code", code); if (input.state) redirect.searchParams.set("state", input.state); redirect.searchParams.set("iss", this.config.oauthIssuer);
    return redirect.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string; clientId: string; redirectUri: string; resource: string }) {
    return transaction(this.store.pool, async (client) => {
      const result = await client.query("SELECT * FROM oauth_authorization_codes WHERE code_hash=$1 FOR UPDATE", [sha256(input.code)]); const row = result.rows[0];
      if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= Date.now()) throw new SpendSealError(400, "invalid_grant", "Authorization code is invalid, expired, or already used.");
      if (row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri || row.resource !== input.resource) throw new SpendSealError(400, "invalid_grant", "Authorization code context does not match.");
      if (!secureEqual(row.code_challenge, pkceChallenge(input.codeVerifier))) throw new SpendSealError(400, "invalid_grant", "PKCE verification failed.");
      await client.query("UPDATE oauth_authorization_codes SET consumed_at=now() WHERE code_hash=$1", [sha256(input.code)]);
      return this.issueTokens(client, { userId: row.user_id, clientId: row.client_id, resource: row.resource, scopes: row.scopes_json, familyId: randomUUID() });
    });
  }

  async refresh(input: { refreshToken: string; clientId: string; resource: string }) {
    const outcome = await transaction(this.store.pool, async (client) => {
      const result = await client.query("SELECT * FROM oauth_tokens WHERE token_hash=$1 AND token_type='refresh' FOR UPDATE", [sha256(input.refreshToken)]); const row = result.rows[0];
      if (!row || row.client_id !== input.clientId || row.resource !== input.resource || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) throw new SpendSealError(400, "invalid_grant", "Refresh token is invalid or expired.");
      if (row.consumed_at) { await client.query("UPDATE oauth_tokens SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL", [row.family_id]); return { reused: true as const }; }
      await client.query("UPDATE oauth_tokens SET consumed_at=now() WHERE id=$1", [row.id]);
      const issued = await this.issueTokens(client, { userId: row.user_id, clientId: row.client_id, resource: row.resource, scopes: row.scopes_json, familyId: row.family_id });
      await client.query("UPDATE oauth_tokens SET replaced_by_id=$2 WHERE id=$1", [row.id, issued.refreshId]);
      return { reused: false as const, issued };
    });
    if (outcome.reused) throw new SpendSealError(400, "invalid_grant", "Refresh token reuse detected; the token family was revoked.");
    return outcome.issued;
  }

  async authenticate(token: string, requiredScope?: string): Promise<OAuthPrincipal | null> {
    const result = await this.store.pool.query(`SELECT * FROM oauth_tokens WHERE token_hash=$1 AND token_type='access' AND revoked_at IS NULL AND expires_at>now()`, [sha256(token)]); const row = result.rows[0];
    if (!row) return null; const scopes = row.scopes_json as string[]; if (requiredScope && !scopes.includes(requiredScope)) return null;
    return { userId: row.user_id, clientId: row.client_id, scopes, resource: row.resource };
  }

  async revoke(token: string): Promise<void> { const result = await this.store.pool.query("SELECT family_id FROM oauth_tokens WHERE token_hash=$1", [sha256(token)]); if (result.rows[0]) await this.store.pool.query("UPDATE oauth_tokens SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL", [result.rows[0].family_id]); }

  private async issueTokens(client: PoolClient, input: { userId: string; clientId: string; resource: string; scopes: string[]; familyId: string }) {
    const accessToken = randomBytes(32).toString("base64url"); const refreshToken = randomBytes(48).toString("base64url"); const accessId = randomUUID(); const refreshId = randomUUID();
    await client.query(`INSERT INTO oauth_tokens(id,token_hash,token_type,family_id,user_id,client_id,resource,scopes_json,expires_at) VALUES
      ($1,$2,'access',$3,$4,$5,$6,$7,now()+interval '15 minutes'),($8,$9,'refresh',$3,$4,$5,$6,$7,now()+interval '30 days')`, [accessId, sha256(accessToken), input.familyId, input.userId, input.clientId, input.resource, JSON.stringify(input.scopes), refreshId, sha256(refreshToken)]);
    return { access_token: accessToken, token_type: "Bearer", expires_in: 900, refresh_token: refreshToken, scope: input.scopes.join(" "), refreshId };
  }

  private allowedClientId(value: string): boolean { return value === this.config.extensionOauthClientId || value === "https://chatgpt.com/oauth/client.json" || /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_-]+\/client\.json$/.test(value) || (process.env.NODE_ENV === "test" && value.startsWith("https://test.client/")); }
  private allowedRedirect(clientId: string, value: string): boolean {
    if (clientId === this.config.extensionOauthClientId) return /^https:\/\/[a-p]{32}\.chromiumapp\.org\/oauth2\/?$/.test(value) || (process.env.NODE_ENV === "test" && value.startsWith("https://test.client/"));
    return value === "https://chatgpt.com/connector_platform_oauth_redirect" || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(value) || (process.env.NODE_ENV === "test" && value.startsWith("https://test.client/"));
  }
}

function pkceChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }
function secureEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
