'use client';

import { useEffect, useRef, useState } from 'react';
import { SignInDialog } from '@/components/SignInDialog';
import { Icon } from '@/components/Icons';
import { Badge } from '@/components/Chips';
import { useSession, truncateAddress } from '@/components/SessionProvider';

const METHOD_LABEL: Record<string, string> = {
  google: 'Google Account',
  x: 'X Account',
  wallet: 'Solana Wallet',
  demo: 'Demo Role Binding',
};

export function AccountButton() {
  const { session, signOut, ready } = useSession();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  if (!ready) {
    return <div className="h-10 w-28 animate-pulse rounded-xl bg-subtle" aria-hidden="true" />;
  }

  return (
    <div className="relative" ref={wrapRef}>
      {session ? (
        <>
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            className="flex h-10 items-center gap-2.5 rounded-xl border border-line-strong bg-white pl-2 pr-3 shadow-xs hover:bg-subtle transition-all duration-150"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-brand-600 to-brand-800 text-xs font-bold text-white shadow-xs">
              {session.label.slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden max-w-[9rem] truncate text-xs font-semibold text-ink sm:block">
              {session.label}
            </span>
            <Icon name="chevron" className="h-3.5 w-3.5 text-muted" />
          </button>

          {menuOpen ? (
            <div
              className="card absolute right-0 top-full z-50 mt-2 w-72 p-4 shadow-pop bg-white border-line animate-in fade-in zoom-in-95 duration-100"
              role="menu"
            >
              <div className="flex items-center gap-3 border-b border-line pb-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 text-sm font-bold text-white shadow-xs">
                  {session.label.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-ink">{session.label}</div>
                  <div className="truncate text-xs text-muted">
                    {METHOD_LABEL[session.method] ?? session.method}
                    {session.address ? ` · ${truncateAddress(session.address)}` : ''}
                  </div>
                </div>
              </div>

              <div className="py-3">
                {session.demoBinding ? (
                  <Badge tone="neutral">Demo Actor · Simulated Auth</Badge>
                ) : (
                  <Badge tone="ok">Verified On-Chain Signature</Badge>
                )}
              </div>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  signOut();
                  setMenuOpen(false);
                }}
                className="ghost w-full py-2 text-xs font-semibold"
              >
                Sign out
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="primary h-10 px-4 text-xs sm:text-sm font-semibold shadow-xs"
        >
          <Icon name="wallet" className="h-4 w-4" />
          <span>Connect / Sign in</span>
        </button>
      )}

      <SignInDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
