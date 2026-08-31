import { useEffect, useRef, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ArrowRight, CheckCircle2, Clock3, Fingerprint, LockKeyhole, ShieldCheck } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api, dateTime, money, shortId } from "../api";
import { Badge, Constraint, ErrorNotice, Reveal } from "../components";
import type { IntentResponse } from "../types";

type AuthenticationOptions = { challengeId: string; options: PublicKeyCredentialRequestOptionsJSON };

export function Approval() {
  const { id = "" } = useParams(); const [params] = useSearchParams(); const navigate = useNavigate();
  const entryToken = params.get("token") ?? "";
  const [data, setData] = useState<IntentResponse | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [checkoutUrl, setCheckoutUrl] = useState("");
  const exchanged = useRef(false);

  useEffect(() => { let active = true; void (async () => {
    try {
      await api("/api/v1/auth/session");
      if (entryToken && !exchanged.current) { exchanged.current = true; await api(`/api/v1/intents/${id}/approval-session`, { method: "POST", body: JSON.stringify({ token: entryToken }) }); window.history.replaceState({}, document.title, window.location.pathname); }
      const details = await api<IntentResponse>(`/api/v1/intents/${id}`); if (active) setData(details);
    } catch (cause) { if (cause instanceof ApiError && cause.code === "AUTH_REQUIRED") { navigate(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`, { replace: true }); return; } if (active) setError(cause instanceof Error ? cause.message : "Approval could not be opened"); }
    finally { if (active) setLoading(false); }
  })(); return () => { active = false; }; }, [entryToken, id, navigate]);

  useEffect(() => {
    let active = true;
    const refreshPermit = () => { void api<IntentResponse>(`/api/v1/intents/${id}`).then((details) => {
      if (!active) return;
      setData(details);
      if (details.intent.status === "paid") setCheckoutUrl("");
    }).catch(() => undefined); };
    window.addEventListener("pageshow", refreshPermit);
    window.addEventListener("focus", refreshPermit);
    return () => { active = false; window.removeEventListener("pageshow", refreshPermit); window.removeEventListener("focus", refreshPermit); };
  }, [id]);

  async function approve() { setBusy(true); setError(""); try { const start = await api<AuthenticationOptions>(`/api/v1/intents/${id}/approval/options`, { method: "POST" }); const response = await startAuthentication({ optionsJSON: start.options }); const result = await api<{ intent: IntentResponse["intent"] }>(`/api/v1/intents/${id}/approve`, { method: "POST", body: JSON.stringify({ challengeId: start.challengeId, response }) }); setData((current) => current ? { ...current, intent: result.intent } : current); } catch (cause) { setError(cause instanceof Error ? cause.message : "Passkey approval failed"); } finally { setBusy(false); } }
  async function prepare() { setBusy(true); setError(""); try { const result = await api<{ checkoutUrl?: string; decision: { message: string; reasons?: string[] } }>(`/api/v1/intents/${id}/checkout`, { method: "POST" }); if (result.checkoutUrl) setCheckoutUrl(result.checkoutUrl); else setError(`${result.decision.reasons?.join(", ") || "CHECKOUT_BLOCKED"}: ${result.decision.message}`); } catch (cause) { setError(cause instanceof Error ? cause.message : "Checkout preparation failed"); } finally { setBusy(false); } }

  if (loading) return <Centered><div className="route-glow" /><div className="trust-preview relative animate-pulse p-8 text-white/45">Securing buyer-bound approval session…</div></Centered>;
  if (!data) return <Centered><div className="route-glow" /><div className="panel relative p-8"><Badge tone="bad">Approval unavailable</Badge><div className="mt-4"><ErrorNotice message={error || "PurchasePermit could not be loaded."} /></div></div></Centered>;
  const confirmed = Boolean(data.intent.confirmedAt);
  const paid = data.intent.status === "paid";
  return <Centered><div className="route-glow" /><Reveal className="relative"><div className="mb-7 text-center"><span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-mint/25 bg-mint/[.09] text-mint"><LockKeyhole size={27} /></span><p className="eyebrow mt-6">Protected AI purchase</p><h1 className="mt-3 text-4xl font-semibold tracking-tight">Review your PurchasePermit</h1><p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-white/45">The link has no approval power by itself. You must be signed in as the same buyer and verify your enrolled passkey.</p></div>
    <div className="trust-preview"><div className="flex items-center justify-between gap-4 border-b border-white/[.08] bg-gradient-to-r from-mint/[.075] to-transparent p-5"><div><p className="font-mono text-[9px] uppercase tracking-wider text-white/35">Merchant-managed authoritative catalog</p><h2 className="mt-2 text-xl font-semibold">{data.product.name}</h2></div><Badge tone={confirmed ? "good" : "warn"}>{paid ? "Permit consumed" : confirmed ? "Passkey approved" : "Awaiting you"}</Badge></div>
      <div className="p-5 sm:p-6"><Constraint label="SKU" value={data.product.sku} /><Constraint label="Locked price" value={<strong className="text-mint">{money(data.intent.lockedUnitPricePaise)}</strong>} /><Constraint label="Maximum total" value={money(data.intent.maxTotalPaise)} /><Constraint label="Price changes" value={data.intent.priceChangePolicy.replaceAll("_", " ")} /><Constraint label="Merchant-stated refund terms" value={data.intent.requireRefundable ? `At least ${data.intent.minimumRefundWindowDays ?? 0} days` : "Not required"} /><Constraint label="Expires" value={<span className="flex items-center gap-2"><Clock3 size={14} />{dateTime(data.intent.expiresAt)}</span>} /><Constraint label="Catalog evidence" value={<span className="max-w-64 text-right text-xs">merchant_managed_catalog · revision {data.product.version}<br /><span className="font-mono text-[9px] text-white/35">{shortId(data.product.snapshotHash)}</span></span>} /></div>
      <div className="border-t border-white/[.08] bg-black/15 p-5">{error && <div className="mb-4"><ErrorNotice message={error} /></div>}{paid ? <><div className="mb-4 rounded-xl border border-mint/20 bg-mint/[.07] p-3 text-sm text-mint">Payment verified. This PurchasePermit has been consumed and cannot create another order.</div><button onClick={prepare} disabled={busy} className="button-secondary w-full"><ShieldCheck size={17} />{busy ? "Testing replay protection…" : "Test replay protection"}</button></> : !confirmed ? <button onClick={approve} disabled={busy} className="button-primary w-full"><Fingerprint size={17} />{busy ? "Verifying authenticator…" : "Approve with my passkey"}</button> : checkoutUrl ? <a href={checkoutUrl} className="button-primary w-full">Open verified checkout <ArrowRight size={16} /></a> : <button onClick={prepare} disabled={busy} className="button-primary w-full"><CheckCircle2 size={17} />{busy ? "Evaluating authoritative revision…" : "Run policy and prepare checkout"}</button>}<p className="mt-3 text-center font-mono text-[8px] uppercase tracking-wider text-white/25">Passkey proves authenticator control—not legal identity · approval is single-use</p></div>
    </div><div className="mt-4 flex gap-3 rounded-xl border border-white/[.07] p-4 text-xs leading-5 text-white/40"><ShieldCheck className="shrink-0 text-mint" size={15} />SpendSeal will reload the current merchant-managed product revision before creating a Test Mode order. Merchant-stated refund terms are checked, not guaranteed.</div><Link to="/" className="mt-6 block text-center text-sm text-white/40">← Return to platform</Link></Reveal></Centered>;
}
function Centered({ children }: { children: React.ReactNode }) { return <div className="route-stage">{children}</div>; }
