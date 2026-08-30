import { useEffect, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { CheckCircle2, Fingerprint, ShieldCheck } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
  const [searchParams] = useSearchParams();
  const continuationId = searchParams.get("continuation");
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
      if (continuationId) {
        const completed = await api<{ redirectUrl: string }>(`/api/v1/shopping-tasks/${id}/approval-continuations/${continuationId}/complete`, { method: "POST" });
        window.location.assign(completed.redirectUrl);
        return;
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passkey approval failed");
    } finally { setBusy(false); }
  }

  async function chooseAnotherProduct() {
    setBusy(true); setError("");
    try {
      if (continuationId) {
        const cancelled = await api<{ redirectUrl: string }>(`/api/v1/shopping-tasks/${id}/approval-continuations/${continuationId}/cancel`, { method: "POST" });
        window.location.assign(cancelled.redirectUrl);
        return;
      }
      await api(`/api/v1/shopping-tasks/${id}/reselect-product`, { method: "POST" });
      navigate("/", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not return to product selection");
      setBusy(false);
    }
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

  async function returnToExtension() {
    if (!continuationId) return;
    setBusy(true); setError("");
    try {
      const completed = await api<{ redirectUrl: string }>(`/api/v1/shopping-tasks/${id}/approval-continuations/${continuationId}/complete`, { method: "POST" });
      window.location.assign(completed.redirectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not return to the extension");
      setBusy(false);
    }
  }

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
          SpendSeal independently observed this checkout in your permitted browser tab. The exact evidence level and execution mode are shown below.
        </p>
      </div>
      <div className="trust-preview">
        <div className="flex items-center justify-between gap-4 border-b border-white/[.08] bg-gradient-to-r from-mint/[.075] to-transparent p-5">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-wider text-white/35">
              {task.site === "amazon_in" ? "Amazon India" : task.site === "flipkart_in" ? "Flipkart" : task.site === "openai_api" ? "OpenAI API billing" : "Agent-assisted website"} purchase adapter
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
          <Constraint label="Items" value={observed ? money(observed.itemSubtotalPaise) : "Waiting"} />
          <Constraint label="Delivery charge" value={observed ? money(observed.shippingPaise) : "Waiting"} />
          <Constraint label="Taxes" value={observed ? money(observed.taxPaise) : "Waiting"} />
          <Constraint label="Discount" value={observed ? money(observed.discountPaise) : "Waiting"} />
          <Constraint label="Complete payable total" value={<strong className="text-mint">{observed ? money(observed.finalTotalPaise) : "Waiting"}</strong>} />
          <Constraint label="Maximum allowed" value={money(task.maxTotalPaise)} />
          <Constraint label="Delivery address" value={observed?.maskedAddressLabel ?? "Address remains local/masked"} />
          <Constraint label="Delivery date" value={observed?.deliveryDate ?? "Not observed"} />
          {task.purchaseKind !== "physical_good" && <Constraint label="Destination account" value={observed?.maskedAccountLabel ?? "Account remains local/masked"} />}
          <Constraint label="Billing" value={observed?.recurring ? "Recurring — blocked" : "One-time only"} />
          <Constraint label="Payment choice" value={task.paymentPreference === "cash_on_delivery" ? "Cash on Delivery" : task.paymentPreference === "online" ? "Online payment" : "Not selected"} />
          <Constraint label="Payment method" value={observed?.paymentMethodType?.replaceAll("_", " ") ?? "Not stored"} />
          {observed?.providerCurrency && <Constraint label="Provider amount" value={`${observed.providerCurrency} ${((observed.providerAmountMinor ?? 0) / 100).toFixed(2)}`} />}
          {observed?.fxQuote && <Constraint label="Currency estimate" value={`₹${observed.fxQuote.rate.toFixed(2)}/USD + ${observed.fxQuote.bufferPercent}% safety buffer`} />}
          {task.site === "openai_api" && <div className="my-4 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-4 text-xs leading-5 text-amber-100/70">
            OpenAI API prepaid credits are non-refundable and expire after one year. This is a one-time credit purchase; automatic recharge is disabled. The INR figure is a buffered estimate, and your bank's final conversion cannot be cryptographically guaranteed.
          </div>}
          <Constraint label="Final action" value={observed?.finalActionLabel ?? "Not observed"} />
          <Constraint label="Observation expires" value={dateTime(permit?.expiresAt ?? task.expiresAt)} />
          <Constraint label="Evidence" value={<span className="max-w-64 text-right text-xs">
            {observed?.evidenceAssurance ?? "browser_observed"} · {observed?.adapterId ?? task.site} v{observed?.adapterVersion ?? "1"}<br />
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
          </button> : approved && continuationId ? <button onClick={returnToExtension} disabled={busy} className="button-primary w-full">
            <CheckCircle2 size={17} />{busy ? "Returning…" : "Return securely to SpendSeal"}
          </button> : approved ? <div className="rounded-xl border border-mint/20 bg-mint/[.07] p-4 text-sm text-mint">
            Approved. SpendSeal will re-check the visible checkout before continuing.
          </div> : <div className="rounded-xl border border-white/10 p-4 text-sm text-white/50">
            Continue in the SpendSeal extension to select a product and collect final checkout evidence.
          </div>}
          {!prepared && !["completed", "submitting", "reconciliation_required"].includes(task.status) && <button onClick={chooseAnotherProduct} disabled={busy} className="button-secondary mt-3 w-full">
            ← Choose another product
          </button>}
          <p className="mt-3 text-center font-mono text-[8px] uppercase tracking-wider text-white/25">
            Passkey proves authenticator control—not legal identity · one execution attempt
          </p>
        </div>
      </div>
      <Link to="/" className="mt-6 block text-center text-sm text-white/40">← Return to SpendSeal</Link>
    </Reveal>
  </div>;
}
