'use client';

import { useEffect, useState } from 'react';
import { ROLE_LABEL } from '@/lib/format';
import { WALLET_OPTIONS } from '@/lib/solana-wallet';
import { ProfileRequiredError, useSession, WalletUnavailableError } from '@/components/SessionProvider';

/**
 * Sign-in dialog.
 *
 * "Connect wallet" is real: the wallet signs a single-use challenge and the API
 * verifies the ed25519 signature. Google and X are UI-only by design - social
 * sign-in needs OAuth credentials AND an embedded-wallet provider so the user
 * still ends up with an address, and neither exists yet. The dialog says so
 * instead of pretending.
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
        // Reuse the SAME challenge and signature: the server did not burn the
        // nonce when it asked for a profile, so the wallet is not prompted twice.
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
        setError(`${caught.message}. Install the extension, or use the demo binding below.`);
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Sign-in failed');
    } finally {
      setBusyWallet(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
    >
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-start justify-between border-b border-ink-800 px-5 py-4">
          <div>
            <div className="text-base font-semibold tracking-tight">Sign in to VIN</div>
            <p className="mt-0.5 text-xs text-mist-400">
              Your wallet is the account. Connect it to trade, or use the demo binding to click through the seeded
              flow.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-mist-400 hover:bg-ink-800 hover:text-paper"
          >
            ✕
          </button>
        </div>

        {profile ? (
          <div className="space-y-3 border-b border-ink-800 bg-signal/5 px-5 py-4">
            <div>
              <div className="text-sm font-medium">Create your account</div>
              <p className="mt-0.5 text-xs text-mist-400">
                <span className="hash">{profile.address}</span> has not signed in before. Pick a name; the signature you
                already made stays valid.
              </p>
            </div>
            <label className="block text-xs uppercase tracking-wider text-mist-400" htmlFor="displayName">
              Display name
            </label>
            <input
              id="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="e.g. Blue Horizon Trading"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="primary"
                disabled={displayName.trim().length < 2 || busyWallet !== null}
                onClick={() => void startWallet(profile.error.walletId, displayName.trim(), profile.error)}
              >
                {busyWallet ? 'Working…' : 'Create account as buyer'}
              </button>
              <button type="button" className="ghost" onClick={() => setProfile(null)}>
                Back
              </button>
            </div>
            <p className="text-[0.68rem] text-mist-400">
              Buyers are self-serve. Seller, workshop and curator accounts need country and email before they can
              operate.
            </p>
          </div>
        ) : null}

        <div className="space-y-2 px-5 py-4">
          <button
            type="button"
            onClick={() => setWalletOpen((value) => !value)}
            className="flex w-full items-center gap-3 rounded-xl border border-signal/50 bg-signal/10 px-4 py-3 text-sm text-signal hover:bg-signal/15"
            aria-expanded={walletOpen}
          >
            <WalletMark />
            <span className="flex-1 text-left">Connect wallet</span>
            <span className="chip border-signal/40 text-signal">real signature</span>
          </button>

          {walletOpen ? (
            <div className="space-y-1.5 rounded-xl border border-ink-700 bg-ink-950/60 p-2">
              {WALLET_OPTIONS.map((wallet) => {
                const detected = walletAvailable(wallet.id);
                return (
                  <button
                    key={wallet.id}
                    type="button"
                    disabled={busyWallet !== null}
                    onClick={() => void startWallet(wallet.id)}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-ink-800 disabled:opacity-50"
                  >
                    <span>{wallet.name}</span>
                    <span className="text-[0.68rem] text-mist-400">{detected ? 'detected' : 'not installed'}</span>
                  </button>
                );
              })}
              {!WALLET_OPTIONS.some((wallet) => walletAvailable(wallet.id)) ? (
                <p className="px-3 py-1 text-[0.68rem] text-mist-400">
                  No Solana wallet extension found in this browser.
                </p>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => {
              void signInLocal('google').then(onClose);
            }}
            className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm hover:border-ink-600 hover:bg-ink-800"
          >
            <GoogleMark />
            <span className="flex-1 text-left">Continue with Google</span>
            <span className="chip text-mist-400">UI only</span>
          </button>
          <button
            type="button"
            onClick={() => {
              void signInLocal('x').then(onClose);
            }}
            className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm hover:border-ink-600 hover:bg-ink-800"
          >
            <XMark />
            <span className="flex-1 text-left">Continue with X</span>
            <span className="chip text-mist-400">UI only</span>
          </button>

          {error ? (
            <p className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p>
          ) : null}
        </div>

        <div className="border-t border-ink-800 px-5 py-4">
          <div className="text-[0.68rem] uppercase tracking-wider text-mist-400">
            Demo binding (no signature, needs the seeded actors)
          </div>
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
          <button
            type="button"
            className="primary mt-3"
            disabled={!demoActorId}
            onClick={() => {
              void signInWithDemoActor(actors.find((actor) => actor.id === demoActorId) ?? null).then(onClose);
            }}
          >
            Continue as this actor
          </button>
          <button type="button" onClick={onClose} className="ghost mt-2 w-full">
            Keep browsing without signing in
          </button>
        </div>

        <p className="border-t border-ink-800 bg-ink-950/60 px-5 py-3 text-[0.68rem] leading-relaxed text-mist-400">
          Wallet sign-in is real: the wallet signs a one-time challenge and the API verifies the ed25519 signature
          before issuing a session token. Google and X are not wired to OAuth yet
          {lastWalletId ? ` (last wallet tried: ${lastWalletId})` : ''}. The demo binding below signs nothing; the API
          accepts it only while demo mode is on.
        </p>
      </div>
    </div>
  );
}
