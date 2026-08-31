import { useEffect } from "react";
import { ArrowUpRight, Bot, ShieldCheck } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";

export function AppShell() {
  const { pathname } = useLocation();

  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "auto" }); }, [pathname]);

  return (
    <div className="relative min-h-screen bg-ink text-white">
      <div className="app-backdrop pointer-events-none fixed inset-0" />
      <div className="noise-layer pointer-events-none fixed inset-0 mix-blend-soft-light" />
      <header className="relative z-30 px-3 pt-3 sm:px-5 sm:pt-5">
        <div className="glass-nav mx-auto flex max-w-[1460px] items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
          <Link to="/" className="flex min-w-0 items-center gap-3 rounded-xl">
            <span className="rail-logo"><ShieldCheck size={20} /></span>
            <span className="text-base font-bold tracking-[-.025em] sm:text-lg">SpendSeal</span>
            <span className="hidden items-center gap-1.5 rounded-full border border-mint/15 bg-mint/[.07] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.16em] text-mint sm:inline-flex"><span className="status-pulse" /> Multi-merchant Test Mode</span>
          </Link>
          <div className="flex items-center gap-2 text-xs text-white/50 sm:gap-4">
            <span className="hidden items-center gap-2 lg:flex"><Bot size={14} className="text-mint/75" /> Buyer offer → Merchant counter → Passkey → Razorpay</span>
            <span className="hidden h-5 w-px bg-white/10 sm:block" />
            <a href="https://razorpay.com/buildathon/" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg px-2 py-2 transition hover:bg-white/[.05] hover:text-white">Buildathon <ArrowUpRight size={13} /></a>
          </div>
        </div>
      </header>
      <main className="relative z-10"><Outlet /></main>
      <footer className="relative z-10 mx-auto mb-4 mt-16 flex max-w-[1460px] flex-col gap-3 border-t border-white/[.08] px-5 py-7 text-xs text-white/35 sm:flex-row sm:items-center sm:justify-between lg:px-8">
        <span>ChatGPT negotiates. The buyer approves. SpendSeal seals the terms. Razorpay executes exactly once.</span>
        <span className="font-mono tracking-wider">DEMO ONLY · NO REAL MONEY</span>
      </footer>
    </div>
  );
}
