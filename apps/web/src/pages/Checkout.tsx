import { useEffect, useState } from "react";
import { CheckCircle2, CreditCard, ExternalLink, LockKeyhole, ShieldCheck } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api, dateTime, money, shortId } from "../api";
import { Badge, Constraint, ErrorNotice, Reveal } from "../components";
import type { CheckoutDetails } from "../types";

declare global { interface Window { Razorpay?: new (options: Record<string, unknown>) => { open(): void; on(event: string, handler: (data: unknown) => void): void } } }

export function Checkout() {
  const { token = "" } = useParams();
  const [data, setData] = useState<CheckoutDetails | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState(false);
  useEffect(() => { api<CheckoutDetails>(`/api/v1/checkout/${token}`).then((result) => { setData(result); setPaid(result.order.status === "paid"); }).catch((e) => setError(e.message)); }, [token]);

  async function pay() {
    if (!data) return;
    setBusy(true); setError("");
    try {
      if (data.adapter === "mock") {
        await api("/api/v1/payments/mock-complete", { method: "POST", body: JSON.stringify({ localOrderId: data.order.id }) });
        setPaid(true); return;
      }
      await loadRazorpay();
      if (!window.Razorpay) throw new Error("Razorpay Checkout could not load.");
      const razorpay = new window.Razorpay({
        key: data.keyId,
        amount: data.order.amountPaise,
        currency: data.order.currency,
        name: data.merchant.displayName,
        description: data.product.name,
        order_id: data.order.providerOrderId,
        theme: { color: "#173e35" },
        handler: async (response: unknown) => {
          const result = response as { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
          await api("/api/v1/payments/verify", { method: "POST", body: JSON.stringify({ localOrderId: data.order.id, razorpayOrderId: result.razorpay_order_id, razorpayPaymentId: result.razorpay_payment_id, razorpaySignature: result.razorpay_signature }) });
          setPaid(true);
        },
      });
      razorpay.on("payment.failed", () => setError("Razorpay reported a simulated payment failure. The IntentLock remains unfulfilled."));
      razorpay.open();
    } catch (e) { setError(e instanceof Error ? e.message : "Payment could not be completed"); }
    finally { setBusy(false); }
  }

  if (!data) return <div className="route-stage"><div className="route-glow" /><div className="trust-preview relative w-full animate-pulse p-8 text-white/45">{error || "Loading verified checkout…"}</div></div>;

  return <div className="route-stage">
    <div className="route-glow" />
    <Reveal className="relative">
      <div className="mb-7 text-center">
        <Badge tone="good"><ShieldCheck size={12} /> All constraints passed</Badge>
        <h1 className="mt-5 text-4xl font-semibold tracking-[-.045em]">Verified checkout</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-white/45">Razorpay receives only the amount AgentRail observed in {data.merchant.displayName}’s merchant-managed catalog.</p>
      </div>

      <div className="trust-preview">
        <div className="relative flex items-center justify-between overflow-hidden border-b border-white/[.08] p-5 sm:p-6">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-mint/[.09] via-transparent to-transparent" />
          <div className="relative"><p className="font-mono text-[9px] uppercase tracking-[.18em] text-white/35">{data.merchant.displayName} · one-time test payment</p><h2 className="mt-2 text-xl font-semibold">{data.product.name}</h2></div>
          <span className="relative grid h-12 w-12 place-items-center rounded-2xl border border-mint/20 bg-mint/[.08] text-mint"><CreditCard /></span>
        </div>

        <div className="grid border-b border-white/[.08] sm:grid-cols-3">
          <CheckoutStep icon={<LockKeyhole />} title="Mandate" detail="Consumed once" />
          <CheckoutStep icon={<ShieldCheck />} title="Policy" detail="All checks passed" />
          <CheckoutStep icon={<CreditCard />} title="Provider" detail={data.adapter === "mock" ? "Mock Test Mode" : "Razorpay Test Mode"} />
        </div>

        <div className="p-5 sm:p-6">
          <div className="mb-5 flex items-end justify-between rounded-2xl border border-mint/15 bg-mint/[.045] p-4"><div><p className="text-xs text-white/40">Authorized amount</p><p className="mt-1 text-3xl font-semibold tracking-[-.04em] text-mint">{money(data.order.amountPaise)}</p></div><Badge tone="good">INR · locked</Badge></div>
          <Constraint label="Provider order" value={<span className="font-mono text-xs">{data.order.providerOrderId}</span>} />
          <Constraint label="IntentLock" value={<span className="font-mono text-xs">{data.intent.id.slice(0, 13)}…</span>} />
          <Constraint label="Catalog evidence" value={<span className="max-w-64 text-right text-xs">merchant_managed_catalog · revision {data.order.observedProductVersion}<br /><span className="font-mono text-[9px] text-white/35">{shortId(data.order.observedProductSnapshotHash)}</span></span>} />
          <Constraint label="Observed" value={dateTime(data.order.observedAt)} />
        </div>

        <div className="border-t border-white/[.08] bg-black/15 p-5 sm:p-6">
          {error && <div className="mb-4"><ErrorNotice message={error} /></div>}
          {paid ? <div className="rounded-2xl border border-mint/25 bg-mint/[.075] p-6 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-mint/20 bg-mint/10"><CheckCircle2 className="text-mint" size={27} /></span><p className="mt-4 text-lg font-semibold">Payment verified</p><p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-white/45">The IntentLock is now consumed. Any replay attempt is deterministically blocked before another order can be created.</p><Link to={`/audit/${data.intent.id}`} className="button-secondary mt-5">Inspect evidence <ExternalLink size={14} /></Link></div> : <button onClick={pay} disabled={busy} className="button-primary w-full"><CreditCard size={17} /> {busy ? "Opening…" : data.adapter === "mock" ? `Simulate ${money(data.order.amountPaise)} payment` : `Pay ${money(data.order.amountPaise)} with Razorpay`}</button>}
          <p className="mt-3 text-center font-mono text-[8px] uppercase tracking-[.16em] text-white/25">{data.adapter} adapter · no real money · stated refund terms checked, not guaranteed</p>
        </div>
      </div>
    </Reveal>
  </div>;
}

function CheckoutStep({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <div className="flex items-center gap-3 border-b border-white/[.07] p-4 last:border-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-mint/15 bg-mint/[.055] text-mint [&>svg]:h-4 [&>svg]:w-4">{icon}</span><div><p className="text-xs font-medium">{title}</p><p className="mt-0.5 text-[10px] text-white/35">{detail}</p></div></div>;
}

async function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => { const script = document.createElement("script"); script.src = "https://checkout.razorpay.com/v1/checkout.js"; script.onload = () => resolve(); script.onerror = () => reject(new Error("Unable to load Razorpay checkout.js")); document.head.appendChild(script); });
}
