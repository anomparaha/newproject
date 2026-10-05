'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DemoActor } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/format';
import { useSession, MOCK_WALLETS, MOCK_TRUNCATE } from '@/components/SessionProvider';

/**
 * The sign-in dialog. Mirrors what a wallet-first product offers - Google, X,
 * and "connect wallet" - but says plainly that it is a demo binding: the API
 * still trusts the `x-actor-id` header, so no challenge is being signed yet.
 */

const GoogleMark = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      fill="currentColor"
      d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1A5.98 5.98 0 0 1 12 6.1a5.4 5.4 0 0 1 3.72 1.45l2.1-2.02A8.6 8.6 0 0 0 12 3.1a8.9 8.9 0 0 0 0 17.8c5.14 0 8.53-3.6 8.53-8.68 0-.58-.06-1.02-.18-1.12z"
    />
  </svg>
);

const XMark = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      fill="currentColor"
      d="M18.9 2.6h3.2l-7 8 8.2 10.8h-6.4l-5-6.6-5.8 6.6H2.9l7.5-8.6L2.5 2.6H9l4.5 6 5.4-6zm-1.1 16.9h1.8L7.3 4.4H5.4l12.4 15.1z"
    />
  </svg>
);

const WalletMark = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path
      fill="currentColor"
      d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v1.5h-7.5a3 3 0 0 0 0 6H19V19a1 1 0 0 1-1 1H5.5A2.5 2.5 0 0 1 3 17.5v-10zm10 4.5a1.5 1.5 0 0 1 1.5-1.5H21v3h-6.5A1.5 1.5 0 0 1 13 12z"
    />
  </svg>
);

export function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { signIn, session } = useSession();
  const [actors, setActors] = useState<DemoActor[]>([]);
  const [walletOpen, setWalletOpen] = useState(false);
  const [demoActorId, setDemoActorId] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/demo/actors');
        if (res.ok) {
          const data = (await res.json()) as { actors: DemoActor[] };
          if (!cancelled) {
            setActors(data.actors);
            setDemoActorId((current) => current || data.actors[0]?.id || '');
          }
        }
      } catch {
        /* API not running: the demo picker stays empty on purpose */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const chosenActor = useMemo(() => actors.find((a) => a.id === demoActorId) ?? null, [actors, demoActorId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const finish = async (method: 'google' | 'x' | 'demo') => {
    const label = method === 'demo' ? chosenActor?.displayName : undefined;
    await signIn(method, { label, actorId: chosenActor?.id });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Sign in">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-start justify-between border-b border-ink-800 px-5 py-4">
          <div>
            <div className="text-base font-semibold tracking-tight">Sign in to VIN</div>
            <p className="mt-0.5 text-xs text-mist-400">
              Choose how you want to continue. Wallet is the native identity; the rest are convenience options.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md px-2 py-1 text-mist-400 hover:bg-ink-800 hover:text-paper">
            ✕
          </button>
        </div>

        <div className="space-y-2 px-5 py-4">
          <button
            type="button"
            onClick={() => void finish('google')}
            className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm hover:border-ink-600 hover:bg-ink-800"
          >
            <GoogleMark />
            <span>Continue with Google</span>
          </button>
          <button
            type="button"
            onClick={() => void finish('x')}
            className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm hover:border-ink-600 hover:bg-ink-800"
          >
            <XMark />
            <span>Continue with X</span>
          </button>
          <button
            type="button"
            onClick={() => setWalletOpen((value) => !value)}
            className="flex w-full items-center gap-3 rounded-xl border border-signal/50 bg-signal/10 px-4 py-3 text-sm text-signal hover:bg-signal/15"
            aria-expanded={walletOpen}
          >
            <WalletMark />
            <span>Connect wallet</span>
          </button>

          {walletOpen ? (
            <div className="space-y-1.5 rounded-xl border border-ink-700 bg-ink-950/60 p-2">
              {MOCK_WALLETS.map((wallet) => (
                <button
                  key={wallet.name}
                  type="button"
                  onClick={() => void signIn('wallet', { address: wallet.address }).then(onClose)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-ink-800"
                >
                  <span>{wallet.name}</span>
                  <span className="hash">{MOCK_TRUNCATE(wallet.address)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="border-t border-ink-800 px-5 py-4">
          <div className="text-[0.68rem] uppercase tracking-wider text-mist-400">Demo binding (API behaviour today)</div>
          <select
            className="mt-2"
            value={demoActorId}
            onChange={(event) => setDemoActorId(event.target.value)}
            aria-label="Demo actor"
          >
            {actors.length === 0 ? <option value="">Backend not running</option> : null}
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.displayName} — {ROLE_LABEL[actor.role] ?? actor.role}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void finish('demo')} className="primary mt-3">
            Continue as this actor
          </button>
          <button type="button" onClick={onClose} className="ghost mt-2 w-full">
            Keep browsing without signing in
          </button>
        </div>

        <p className="border-t border-ink-800 bg-ink-950/60 px-5 py-3 text-[0.68rem] leading-relaxed text-mist-400">
          {session
            ? `Signed in as ${session.label}. `
            : ''}
          Demo notice: no wallet challenge is signed yet. Until Sign-In With Solana is wired in, identity is the
          <code className="mx-1 text-mist-300">x-actor-id</code>
          header, and the buttons above only bind this browser to a demo actor.
        </p>
      </div>
    </div>
  );
}
