import { useEffect, useState } from "react";
import { Braces, CheckCircle2, Copy, Fingerprint, Link2, ShieldAlert, ShieldCheck } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import type { AuditEvent } from "@spendseal/core";
import { api, dateTime, shortId } from "../api";
import { Badge, ErrorNotice, Reveal } from "../components";

import type { AuditData } from "../types";

export function AuditPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<AuditData | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<AuditData>(`/api/v1/intents/${id}/audit`)
      .then((result) => { setData(result); setSelected(result.events.at(-1) ?? null); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Audit evidence could not be loaded"));
  }, [id]);

  if (!data) return <div className="route-stage max-w-5xl"><div className="route-glow" /><div className="trust-preview relative animate-pulse p-8 text-white/45">{error ? <ErrorNotice message={error} /> : "Loading hash-linked evidence…"}</div></div>;

  return <div className="mx-auto max-w-[1460px] px-5 py-12 lg:px-8 lg:py-16">
    <Reveal>
      <div className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="eyebrow">Security evidence console</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-.045em] sm:text-5xl">PurchasePermit decision trail</h1>
          <p className="mt-3 font-mono text-[10px] text-white/30">{id}</p>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-white/42">PostgreSQL triggers block normal updates and deletes; SHA-256 linked hashes reveal offline modification. Each PurchasePermit has its own chain. This is tamper-evident—not blockchain, externally anchored, or absolutely tamper-proof.</p>
        </div>
        <div className={`flex min-w-64 items-center gap-4 rounded-2xl border p-4 ${data.verification.valid ? "border-mint/20 bg-mint/[.065]" : "border-red-400/20 bg-red-400/[.07]"}`}>
          <span className={`grid h-11 w-11 place-items-center rounded-xl border ${data.verification.valid ? "border-mint/20 bg-mint/[.07] text-mint" : "border-red-400/20 bg-red-400/[.07] text-red-300"}`}>{data.verification.valid ? <ShieldCheck /> : <ShieldAlert />}</span>
          <div><p className="text-sm font-semibold">{data.verification.valid ? "SHA-256 chain verified" : "Chain verification failed"}</p><p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-white/35">{data.verification.checked} entries checked</p></div>
        </div>
      </div>
    </Reveal>

    <Reveal delay={100} className="grid gap-5 lg:grid-cols-[.86fr_1.14fr]">
      <section className="section-shell console-grid max-h-[72vh] overflow-y-auto p-3" aria-label="Audit event timeline">
        <div className="sticky top-0 z-20 mb-2 flex items-center justify-between rounded-xl border border-white/[.07] bg-[#091410]/90 px-4 py-3 backdrop-blur-xl"><div><p className="font-mono text-[9px] uppercase tracking-[.18em] text-mint">Append-only timeline</p><p className="mt-1 text-xs text-white/35">Select an event to inspect its evidence</p></div><Badge>{data.events.length} events</Badge></div>
        {data.events.map((event, index) => {
          const active = selected?.sequence === event.sequence;
          const denied = event.reasonCode && event.reasonCode !== "ALLOWED";
          return <button key={event.sequence} type="button" aria-pressed={active} onClick={() => setSelected(event)} className={`group relative flex w-full gap-4 rounded-xl border p-4 text-left transition duration-300 ${active ? "border-mint/25 bg-mint/[.07]" : "border-transparent hover:border-white/[.06] hover:bg-white/[.025]"}`}>
            <div className={`relative z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full border font-mono text-[10px] transition ${active ? "border-mint/30 bg-mint/[.12] text-mint shadow-[0_0_24px_rgba(124,244,196,.12)]" : denied ? "border-red-400/20 bg-red-400/[.06] text-red-300" : "border-white/10 bg-[#0b1713] text-white/40"}`}>{event.sequence}</div>
            {index < data.events.length - 1 && <span className={`absolute left-[2.25rem] top-14 h-[calc(100%-1.85rem)] w-px ${active ? "bg-mint/25" : "bg-white/[.08]"}`} />}
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium capitalize">{event.eventType.replaceAll("_", " ").toLowerCase()}</span>{event.reasonCode && <Badge tone={event.reasonCode === "ALLOWED" ? "good" : "bad"}>{event.reasonCode}</Badge>}</div><p className="mt-1 text-xs text-white/35">{event.actor} · {dateTime(event.createdAt)}</p><p className="mt-2 truncate font-mono text-[9px] text-mint/40">{shortId(event.hash)}</p></div>
          </button>;
        })}
      </section>

      <section className="section-shell console-grid min-h-[560px] p-5 sm:p-7" aria-live="polite">
        {selected ? <>
          <div className="mb-7 flex items-start justify-between gap-4 border-b border-white/[.08] pb-6"><div><p className="eyebrow">Event #{selected.sequence}</p><h2 className="mt-3 text-2xl font-semibold capitalize tracking-tight">{selected.eventType.replaceAll("_", " ").toLowerCase()}</h2><p className="mt-2 text-xs text-white/35">Recorded by <span className="text-white/60">{selected.actor}</span></p></div><span className="grid h-11 w-11 place-items-center rounded-xl border border-mint/20 bg-mint/[.07] text-mint"><CheckCircle2 /></span></div>
          <div className="grid gap-3 sm:grid-cols-2"><Evidence label="Actor" value={selected.actor} /><Evidence label="Reason code" value={selected.reasonCode ?? "—"} /><Evidence label="Recorded" value={dateTime(selected.createdAt)} /><Evidence label="Tenant scope" value={`${selected.scopeType}:${shortId(selected.scopeId)}`} /></div>
          <div className="mt-6"><div className="mb-2 flex items-center justify-between"><span className="flex items-center gap-2 text-xs text-white/40"><Braces size={14} className="text-mint" /> Canonical event payload</span><button type="button" aria-label="Copy canonical payload" onClick={() => navigator.clipboard.writeText(JSON.stringify(selected.payload, null, 2))} className="rounded-lg p-2 text-white/35 transition hover:bg-white/[.05] hover:text-white"><Copy size={14} /></button></div><pre className="max-h-64 overflow-auto rounded-xl border border-white/[.08] bg-black/25 p-4 font-mono text-[11px] leading-5 text-white/60">{JSON.stringify(selected.payload, null, 2)}</pre></div>
          <div className="mt-5 space-y-3 font-mono text-[10px]"><HashRow icon={<Link2 />} label="Previous" value={selected.previousHash} /><HashRow icon={<Fingerprint />} label="SHA-256" value={selected.hash} /></div>
        </> : <div className="grid h-full place-items-center text-white/30">Select an event to inspect its evidence</div>}
      </section>
    </Reveal>

    <Link to="/" className="mt-7 inline-block text-sm text-white/40 transition hover:text-white">← Return to AI Sales Channel</Link>
  </div>;
}

function Evidence({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-white/[.07] bg-black/15 p-3"><p className="font-mono text-[9px] uppercase tracking-[.14em] text-white/30">{label}</p><p className="mt-2 text-sm capitalize">{value}</p></div>; }
function HashRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div className="flex items-center gap-3 rounded-xl border border-white/[.07] bg-black/10 p-3"><span className="text-mint [&>svg]:h-4 [&>svg]:w-4">{icon}</span><span className="w-16 text-white/30">{label}</span><span className="min-w-0 truncate text-white/55">{value}</span></div>; }
