import { useEffect, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { CheckCircle2, Fingerprint, ShieldCheck } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api, dateTime, money, shortId } from "../api";
import { Badge, Constraint, ErrorNotice, Reveal } from "../components";
import type { ShoppingTaskResponse } from "../types";

type AuthenticationOptions = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

export function ShoppingTaskPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<ShoppingTaskResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void load(); }, [id]);

  async function load() {
    try {
      await api("/api/v1/auth/session");
      setData(await api<ShoppingTaskResponse>(`/api/v1/shopping-tasks/${id}`));
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "AUTH_REQUIRED") {
        navigate(`/login?returnTo=${encodeURIComponent(`/shopping/${id}`)}`, { replace: true });
        return;
      }
      setError(cause instanceof Error ? cause.message : "Shopping Task could not be loaded");
    }
  }

  async function approve() {
    setBusy(true); setError("");
    try {
      const start = await api<AuthenticationOptions>(
        `/api/v1/shopping-tasks/${id}/approval/options`,
        { method: "POST" },
      );
      const response = await startAuthentication({ optionsJSON: start.options });
      await api(`/api/v1/shopping-tasks/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ challengeId: start.challengeId, response }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passkey approval failed");
    } finally { setBusy(false); }
  }

  if (!data) return <div className="route-stage">
    <div className="route-glow" />
    <div className="panel relative p-8">
      {error ? <ErrorNotice message={error} /> : "Loading browser checkout evidence…"}
    </div>
  </div>;

  const { task, permit } = data;
  const observed = permit?.checkoutSnapshot;
  const approved = task.status === "approved";
  const prepared = task.status === "prepared";

  return <div className="route-stage max-w-3xl">
    <div className="route-glow" />
    <Reveal className="relative">
      <div className="mb-7 text-center">
        <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-mint/25 bg-mint/[.09] text-mint">
          <ShieldCheck size={27} />
        </span>
        <p className="eyebrow mt-6">Browser-observed purchase chamber</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Review your Purchase Seal</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-white/45">
          SpendSeal observed this checkout in your local browser. It is not provider-verified, and the showcase will not place a live order.
        </p>
      </div>
      <div className="trust-preview">
        <div className="flex items-center justify-between gap-4 border-b border-white/[.08] bg-gradient-to-r from-mint/[.075] to-transparent p-5">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-wider text-white/35">
              {task.site === "amazon_in" ? "Amazon India" : "Flipkart"} browser adapter
            </p>
            <h2 className="mt-2 text-xl font-semibold">{observed?.title ?? task.query ?? "Exact product"}</h2>
          </div>
          <Badge tone={prepared || approved ? "good" : "warn"}>
            {prepared ? "Purchase prepared" : approved ? "Passkey approved" : task.status.replaceAll("_", " ")}
          </Badge>
        </div>
        <div className="p-5 sm:p-6">
          <Constraint label="Exact product ID" value={observed?.canonicalProductId ?? "Waiting for checkout"} />
          <Constraint label="Seller" value={observed?.seller ?? "Not stated"} />
          <Constraint label="Variant" value={observed?.variant ?? "No substitution"} />
          <Constraint label="Quantity" value={observed?.quantity ?? 1} />
          <Constraint label="Complete payable total" value={<strong className="text-mint">{observed ? money(observed.finalTotalPaise) : "Waiting"}</strong>} />
          <Constraint label="Maximum allowed" value={money(task.maxTotalPaise)} />
          <Constraint label="Delivery" value={observed?.maskedAddressLabel ?? "Address remains local/masked"} />
          <Constraint label="Payment method" value={observed?.paymentMethodType ?? "Not stored"} />
          <Constraint label="Observation expires" value={dateTime(permit?.expiresAt ?? task.expiresAt)} />
          <Constraint label="Evidence" value={<span className="max-w-64 text-right text-xs">
            browser_observed · {observed?.adapterId ?? task.site} v{observed?.adapterVersion ?? "1"}<br />
            <span className="font-mono text-[9px] text-white/35">
              {task.checkoutSnapshotHash ? shortId(task.checkoutSnapshotHash) : "pending"}
            </span>
          </span>} />
        </div>
        <div className="border-t border-white/[.08] bg-black/15 p-5">
          {error && <div className="mb-4"><ErrorNotice message={error} /></div>}
          {prepared ? <div className="rounded-xl border border-mint/20 bg-mint/[.07] p-4 text-sm text-mint">
            <CheckCircle2 className="mr-2 inline" size={17} />PURCHASE_PREPARED. No live order was submitted.
          </div> : task.status === "pending_approval" ? <button onClick={approve} disabled={busy} className="button-primary w-full">
            <Fingerprint size={17} />{busy ? "Verifying passkey…" : "Approve exact Purchase Seal"}
          </button> : approved ? <div className="rounded-xl border border-mint/20 bg-mint/[.07] p-4 text-sm text-mint">
            Approved. Return to the extension and click “Re-check and prepare purchase.”
          </div> : <div className="rounded-xl border border-white/10 p-4 text-sm text-white/50">
            Continue in the SpendSeal extension to select a product and collect final checkout evidence.
          </div>}
          <p className="mt-3 text-center font-mono text-[8px] uppercase tracking-wider text-white/25">
            Passkey proves authenticator control—not legal identity · one execution attempt
          </p>
        </div>
      </div>
      <Link to="/" className="mt-6 block text-center text-sm text-white/40">← Return to SpendSeal</Link>
    </Reveal>
  </div>;
}
