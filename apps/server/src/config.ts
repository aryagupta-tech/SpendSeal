import { createHash } from "node:crypto";

export type Config = {
  port: number;
  host: string;
  publicBaseUrl: string;
  databaseUrl: string;
  credentialEncryptionKey: Buffer;
  credentialEncryptionKeyVersion: number;
  oauthIssuer: string;
  webauthnRpId: string;
  webauthnOrigin: string;
  webauthnRpName: string;
  demoMode: boolean;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  localRazorpayKeyId: string | null;
  localRazorpayKeySecret: string | null;
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const defaultBaseUrl = process.env.VERCEL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "spendseal.vercel.app"}` : "http://localhost:43117";
  const publicBaseUrl = overrides.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? defaultBaseUrl;
  const webauthnOrigin = overrides.webauthnOrigin ?? process.env.WEBAUTHN_ORIGIN ?? publicBaseUrl;
  const key = encryptionKey(process.env.CREDENTIAL_ENCRYPTION_KEY);
  return {
    port: Number(process.env.PORT ?? 43117),
    host: process.env.HOST ?? "127.0.0.1",
    publicBaseUrl,
    databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "postgresql://agentrail:agentrail-local-only@127.0.0.1:5432/agentrail",
    credentialEncryptionKey: key,
    credentialEncryptionKeyVersion: Number(process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION ?? 1),
    oauthIssuer: process.env.OAUTH_ISSUER ?? publicBaseUrl,
    webauthnRpId: process.env.WEBAUTHN_RP_ID ?? new URL(webauthnOrigin).hostname,
    webauthnOrigin,
    webauthnRpName: process.env.WEBAUTHN_RP_NAME ?? "SpendSeal",
    demoMode: process.env.DEMO_MODE === "true",
    sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 30),
    sessionAbsoluteHours: Number(process.env.SESSION_ABSOLUTE_HOURS ?? 8),
    localRazorpayKeyId: process.env.RAZORPAY_KEY_ID?.startsWith("rzp_test_") ? process.env.RAZORPAY_KEY_ID : null,
    localRazorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || null,
    ...overrides,
  };
}

function encryptionKey(value: string | undefined): Buffer {
  if (!value) {
    if (process.env.NODE_ENV === "production") throw new Error("CREDENTIAL_ENCRYPTION_KEY is required in production");
    return createHash("sha256").update("agentrail-insecure-local-development-key").digest();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return decoded;
}
