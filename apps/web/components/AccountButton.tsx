'use client';

import { useState } from 'react';
import { SignInDialog } from '@/components/SignInDialog';
import { useSession, MOCK_TRUNCATE } from '@/components/SessionProvider';

const METHOD_LABEL: Record<string, string> = {
  google: 'Google',
  x: 'X',
  wallet: 'Wallet',
  demo: 'Demo actor',
};

export function AccountButton() {
  const { session, signOut, ready } = useSession();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  if (!ready) {
    return <div className="h-11 animate-pulse rounded-xl border border-ink-800 bg-ink-900/60" aria-hidden="true" />;
  }

  return (
    <div className="relative">
      {session ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            className="flex flex-1 items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2 text-left hover:border-ink-600"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-signal/20 text-[0.7rem] font-semibold text-signal">
              {session.label.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-paper">{session.label}</span>
              <span className="block text-[0.62rem] uppercase tracking-wider text-mist-400">
                {METHOD_LABEL[session.method] ?? session.method}
                {session.address ? ` · ${MOCK_TRUNCATE(session.address)}` : ''}
              </span>
            </span>
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-xl" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  signOut();
                  setMenuOpen(false);
                }}
                className="w-full px-3 py-2 text-left text-xs text-mist-300 hover:bg-ink-800 hover:text-paper"
              >
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="primary">
          Sign in
        </button>
      )}

      <SignInDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
