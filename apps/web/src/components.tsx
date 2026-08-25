import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ShieldAlert, ShieldCheck } from "lucide-react";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "good" | "bad" | "warn" | "neutral" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function SectionTitle({ eyebrow, title, aside }: { eyebrow: string; title: string; aside?: ReactNode }) {
  return <div className="mb-5 flex items-end justify-between gap-4"><div><p className="eyebrow">{eyebrow}</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h2></div>{aside}</div>;
}

export function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? <span className="status-icon good"><ShieldCheck /></span> : <span className="status-icon bad"><ShieldAlert /></span>;
}

export function Constraint({ label, value, pass = true }: { label: string; value: ReactNode; pass?: boolean }) {
  return <div className="flex items-center justify-between gap-4 border-b border-white/[.07] py-3 last:border-0"><span className="text-sm text-white/50">{label}</span><span className="flex items-center gap-2 text-right text-sm font-medium">{pass && <Check size={14} className="text-mint" />}{value}</span></div>;
}

export function ErrorNotice({ message }: { message: string }) {
  return <div role="alert" className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200 shadow-[inset_0_1px_0_rgba(255,255,255,.04)]">{message}</div>;
}

export function Reveal({ children, className = "", delay = 0, id }: { children: ReactNode; className?: string; delay?: number; id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || !("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "0px 0px -8%", threshold: 0.08 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} id={id} className={`reveal ${visible ? "is-visible" : ""} ${className}`} style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}>{children}</div>;
}
