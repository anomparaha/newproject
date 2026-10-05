'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ROLE_LABEL } from '@/lib/format';
import { WALLET_OPTIONS } from '@/lib/solana-wallet';
import { ProfileRequiredError, useSession, WalletUnavailableError } from '@/components/SessionProvider';
import { Icon } from '@/components/Icons';
import { Badge } from '@/components/Chips';

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

export function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    signInWithWallet,
    signInWithDemoActor,
    signInLocal,
    walletAvailable,
    actors,
    lastWalletId,
  } = useSession();

  const [walletOpen, setWalletOpen] = useState(false);
  const [busyWallet, setBusyWallet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demoActorId, setDemoActorId] = useState('');
  const [profile, setProfile] = useState<{ address: string; error: ProfileRequiredError } | null>(null);
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProfile(null);
    setDisplayName('');
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    setDemoActorId((current) => current || actors[0]?.id || '');
  }, [actors]);

  if (!open) return null;

  const startWallet = async (walletId: string, withProfile?: string, retry?: ProfileRequiredError) => {
    setBusyWallet(walletId);
    setError(null);
    try {
      if (retry && withProfile) {
        await signInWithWallet({
          walletId,
          displayName: withProfile,
          reuse: {
            address: retry.address,
            nonce: retry.challenge.nonce,
            signature: retry.signature,
          },
        });
        onClose();
        return;
      }
      await signInWithWallet({ walletId });
      onClose();
    } catch (caught) {
      if (caught instanceof ProfileRequiredError) {
        setProfile({ address: caught.address, error: caught });
        setError(null);
        return;
      }
      if (caught instanceof WalletUnavailableError) {
        setError(`${caught.message}. Install the browser extension, or select a demo actor below.`);
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Sign-in failed');
    } finally {
      setBusyWallet(null);
    }
  };

  const dialog = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 px-4 py-6 backdrop-blur-md animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl border border-line bg-white shadow-pop">
        <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 border-b border-line">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <Icon name="shield" className="h-4 w-4" />
              </span>
              <div className="text-xl font-bold tracking-tight text-ink">Authenticate Identity</div>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              Connect your cryptographic Solana wallet to verify your role, or select a demo entity.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-muted hover:bg-subtle hover:text-ink transition-colors"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>

        {profile ? (
          <div className="mx-6 my-4 space-y-3 rounded-2xl border border-slate-300 bg-slate-50 p-4">
            <div>
              <div className="text-sm font-bold text-ink">Create New Buyer Account</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                Address <span className="hash font-mono">{profile.address}</span> is new to the registry. Enter your display name.
              </p>
            </div>
            <div>
              <label htmlFor="displayName" className="text-xs font-semibold text-muted uppercase tracking-wider">
                Display Entity Name
              </label>
              <input
                id="displayName"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="e.g. Apex Global Trading"
                autoFocus
                className="mt-1"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                className="primary flex-1 py-2.5 text-xs font-bold"
                disabled={displayName.trim().length < 2 || busyWallet !== null}
                onClick={() => void startWallet(profile.error.walletId, displayName.trim(), profile.error)}
              >
                {busyWallet ? 'Registering…' : 'Register Account'}
              </button>
              <button type="button" className="ghost px-4 py-2.5 text-xs" onClick={() => setProfile(null)}>
                Back
              </button>
            </div>
          </div>
        ) : null}

        <div className="space-y-3 px-6 py-5">
          <button
            type="button"
            onClick={() => setWalletOpen((value) => !value)}
            className="primary w-full justify-between px-4 py-3 text-sm font-semibold shadow-xs"
            aria-expanded={walletOpen}
          >
            <div className="flex items-center gap-2.5">
              <Icon name="wallet" className="h-4 w-4" />
              <span>Connect Solana Wallet</span>
            </div>
            <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider">
              Ed25519 Verified
            </span>
          </button>

          {walletOpen ? (
            <div className="space-y-1.5 rounded-2xl border border-line bg-subtle/50 p-2.5">
              {WALLET_OPTIONS.map((wallet) => {
                const detected = walletAvailable(wallet.id);
                return (
                  <button
                    key={wallet.id}
                    type="button"
                    disabled={busyWallet !== null}
                    onClick={() => void startWallet(wallet.id)}
                    className="flex w-full items-center justify-between rounded-xl bg-white px-3.5 py-2.5 text-left text-xs font-semibold text-ink shadow-xs border border-slate-200 hover:border-slate-400 hover:bg-slate-50 transition-all disabled:opacity-50"
                  >
                    <span>{wallet.name}</span>
                    <span className={`text-[0.7rem] ${detected ? 'text-ok font-bold' : 'text-muted'}`}>
                      {detected ? 'Installed' : 'Extension Missing'}
                    </span>
                  </button>
                );
              })}
              {!WALLET_OPTIONS.some((wallet) => walletAvailable(wallet.id)) ? (
                <p className="px-2 py-1 text-xs text-muted">No compatible Solana browser extension detected.</p>
              ) : null}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => {
                void signInLocal('google').then(onClose);
              }}
              className="ghost w-full justify-center px-3 py-2.5 text-xs font-semibold"
            >
              <GoogleMark />
              <span>Google</span>
              <Badge tone="neutral">UI Only</Badge>
            </button>
            <button
              type="button"
              onClick={() => {
                void signInLocal('x').then(onClose);
              }}
              className="ghost w-full justify-center px-3 py-2.5 text-xs font-semibold"
            >
              <XMark />
              <span>X (Twitter)</span>
              <Badge tone="neutral">UI Only</Badge>
            </button>
          </div>

          {error ? (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">
              {error}
            </p>
          ) : null}
        </div>

        {/* Demo Binding Box */}
        <div className="border-t border-line bg-subtle/70 px-6 py-5 space-y-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-ink flex items-center gap-1.5">
              <span>Quick Demo Role Simulator</span>
              <span className="rounded bg-brand-100 text-brand-800 px-1.5 py-0.2 text-[0.65rem] font-bold">
                Test Mode
              </span>
            </div>
            <p className="text-xs text-muted mt-0.5">Switch between test Buyer, Seller, Inspector, or Arbiter accounts.</p>
          </div>

          <select
            value={demoActorId}
            onChange={(event) => setDemoActorId(event.target.value)}
            aria-label="Demo actor selection"
            className="text-xs font-medium"
          >
            {actors.length === 0 ? <option value="">Backend not running</option> : null}
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.displayName} — {ROLE_LABEL[actor.role] ?? actor.role}
              </option>
            ))}
          </select>

          <div className="flex gap-2">
            <button
              type="button"
              className="primary flex-1 py-2.5 text-xs font-bold"
              disabled={!demoActorId}
              onClick={() => {
                void signInWithDemoActor(actors.find((actor) => actor.id === demoActorId) ?? null).then(onClose);
              }}
            >
              Simulate this Role
            </button>
            <button type="button" onClick={onClose} className="ghost px-3 py-2.5 text-xs font-semibold">
              Dismiss
            </button>
          </div>
        </div>

        <div className="border-t border-line px-6 py-3.5 text-[0.7rem] text-muted leading-relaxed">
          Ed25519 signature verified on the server side prior to issuing session token.
          {lastWalletId ? ` Last wallet requested: ${lastWalletId}.` : ''}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
