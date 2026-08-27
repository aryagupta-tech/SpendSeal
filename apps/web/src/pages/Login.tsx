import { useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { Fingerprint, ShieldCheck } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Badge, ErrorNotice } from "../components";

type RegistrationOptions = { challengeId: string; options: PublicKeyCredentialCreationOptionsJSON };
type AuthenticationOptions = { challengeId: string; options: PublicKeyCredentialRequestOptionsJSON };

export function Login() {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate(); const [params] = useSearchParams();

  async function submit() {
    setBusy(true); setError("");
    try {
      const normalizedUsername = username.trim();
      const normalizedDisplayName = displayName.trim();
      if (normalizedUsername.length < 3) throw new Error("Username must contain at least 3 characters.");
      if (!/^[a-zA-Z0-9@._+-]+$/.test(normalizedUsername)) throw new Error("Username can only use letters, numbers, and @ . _ + - characters.");
      if (mode === "register" && !normalizedDisplayName) throw new Error("Display name is required.");
      if (!("PublicKeyCredential" in window)) throw new Error("This browser does not support passkeys.");
      if (mode === "register") {
        const start = await api<RegistrationOptions>("/api/v1/auth/passkeys/register/options", { method: "POST", body: JSON.stringify({ username: normalizedUsername, displayName: normalizedDisplayName }) });
        const response = await startRegistration({ optionsJSON: start.options });
        await api("/api/v1/auth/passkeys/register/verify", { method: "POST", body: JSON.stringify({ challengeId: start.challengeId, response }) });
      } else {
        const start = await api<AuthenticationOptions>("/api/v1/auth/passkeys/login/options", { method: "POST", body: JSON.stringify({ username: normalizedUsername }) });
        const response = await startAuthentication({ optionsJSON: start.options });
        await api("/api/v1/auth/passkeys/login/verify", { method: "POST", body: JSON.stringify({ challengeId: start.challengeId, response }) });
      }
      const returnTo = params.get("returnTo"); navigate(returnTo?.startsWith("/") ? returnTo : "/", { replace: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Passkey authentication failed"); }
    finally { setBusy(false); }
  }

  return <div className="route-stage"><div className="route-glow" /><div className="trust-preview relative p-6 sm:p-8">
    <Badge tone="good"><ShieldCheck size={12} /> Passwordless account security</Badge>
    <h1 className="mt-5 text-3xl font-semibold tracking-tight">{mode === "register" ? "Create your AgentRail account" : "Sign in with your passkey"}</h1>
    <p className="mt-3 text-sm leading-6 text-white/45">One account can buy products and manage any merchants it belongs to. The passkey proves control of your authenticator—not KYC or legal identity.</p>
    {error && <div className="mt-5"><ErrorNotice message={error} /></div>}
    <div className="mt-6 space-y-4">
      <label><span className="label">Username</span><input className="field" autoComplete="username webauthn" maxLength={120} value={username} onChange={(event) => setUsername(event.target.value)} onBlur={() => setUsername((value) => value.trim())} placeholder="arya" /></label>
      {mode === "register" && <label><span className="label">Display name</span><input className="field" maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} onBlur={() => setDisplayName((value) => value.trim())} placeholder="Arya" /></label>}
      <button className="button-primary w-full" onClick={submit} disabled={busy || username.trim().length < 3 || (mode === "register" && !displayName.trim())}><Fingerprint size={17} />{busy ? "Waiting for authenticator…" : mode === "register" ? "Create account with passkey" : "Sign in with passkey"}</button>
    </div>
    <button className="mt-5 w-full text-sm text-white/45 hover:text-white" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "register" ? "Already registered? Sign in" : "New here? Create an account"}</button>
  </div></div>;
}
