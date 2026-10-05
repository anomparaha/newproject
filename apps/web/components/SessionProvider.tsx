'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DemoActor } from '@/lib/api';
import {
  WalletUnavailableError,
  connectWallet,
  detectWallet,
  signChallenge,
} from '@/lib/solana-wallet';

/**
 * Session state for the web app.
 *
 * Two kinds of session exist and the UI must never blur them:
 *
 *  - `demoBinding: false` — a REAL Sign-In With Solana. The wallet signed a
 *    single-use nonce, the API verified the ed25519 signature, and every write
 *    carries the returned session token.
 *  - `demoBinding: true` — a LOCAL binding to a seeded demo actor. No signature
 *    exists; the API accepts it only while VIN_DEMO_MODE is on. This is what
 *    makes the seeded flow clickable without a wallet extension.
 *
 * The token is kept in localStorage. For this demo that is acceptable; a
 * production build should put it in an httpOnly cookie, and the comment here
 * exists so nobody mistakes it for a deliberate choice.
 */
export interface Session {
  /** How the user got in. */
  method: 'google' | 'x' | 'wallet' | 'demo';
  /** Display label: a truncated wallet address, or a demo actor name. */
  label: string;
  /** Wallet address, when known. */
  address?: string;
  /** Bound demo actor, for demo bindings. */
  actorId?: string;
  /** Session token from a verified SIWS sign-in. */
  token?: string;
  /** ISO expiry of the token. */
  expiresAt?: string;
  /** True when nothing was signed and the API's demo header is doing the work. */
  demoBinding?: boolean;
}

const STORAGE_KEY = 'vin.session';

export const truncateAddress = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;

function readStored(): Session | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed || typeof parsed.method !== 'string' || typeof parsed.label !== 'string') return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

/** Thrown when a brand-new wallet needs a profile before an account can exist. */
export class ProfileRequiredError extends Error {
  constructor(
    readonly walletId: string,
    readonly address: string,
    readonly challenge: { nonce: string; message: string },
    readonly signature: string,
  ) {
    super('PROFILE_REQUIRED');
  }
}

export interface WalletSignInInput {
  walletId: string;
  /** Required only for wallets that have no account yet. */
  role?: 'buyer' | 'seller' | 'inspector' | 'curator' | 'arbiter';
  displayName?: string;
  countryCode?: string;
  email?: string;
  /**
   * Reuse an already-signed challenge instead of asking the wallet again. Set
   * when a profile had to be collected: the server did not burn the nonce, so
   * the user sees ONE wallet prompt for the whole sign-in.
   */
  reuse?: { address: string; nonce: string; signature: string };
}

interface SessionState {
  session: Session | null;
  ready: boolean;
  /** True while a sign-in handshake is in flight. */
  pending: boolean;
  /** The wallet chosen in the last attempt, so a retry can reuse it. */
  lastWalletId: string | null;
  signInWithWallet: (input: WalletSignInInput) => Promise<Session>;
  signInWithDemoActor: (actor: DemoActor | null) => Promise<void>;
  signInLocal: (method: 'google' | 'x') => Promise<void>;
  signOut: () => void;
  /** True when a wallet extension is actually present in this browser. */
  walletAvailable: (walletId?: string) => boolean;
  /** Headers that authenticate API writes. */
  authHeaders: () => Record<string, string>;
  /** Demo actors the API exposes (used by the demo binding picker). */
  actors: DemoActor[];
  /** The demo actor bound to this browser, resolved from the session. */
  actor: DemoActor | null;
  /** Bind this browser to a demo actor (what the dialog's demo picker does). */
  bindActor: (id: string | null) => void;
}

const SessionContext = createContext<SessionState>({
  session: null,
  ready: false,
  pending: false,
  lastWalletId: null,
  signInWithWallet: async () => {
    throw new Error('SessionProvider is not mounted');
  },
  signInWithDemoActor: async () => undefined,
  signInLocal: async () => undefined,
  signOut: () => undefined,
  walletAvailable: () => false,
  authHeaders: () => ({}),
  actors: [],
  actor: null,
  bindActor: () => undefined,
});

function persist(session: Session | null): void {
  if (typeof window === 'undefined') return;
  if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else window.localStorage.removeItem(STORAGE_KEY);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [lastWalletId, setLastWalletId] = useState<string | null>(null);
  const [actors, setActors] = useState<DemoActor[]>([]);

  useEffect(() => {
    const stored = readStored();
    setSessionState(stored);
    setReady(true);
  }, []);

  // The demo actor list is what makes a bound actor resolvable. Without the API
  // running this stays empty and the sign-in dialog says so.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/demo/actors');
        if (!res.ok) return;
        const data = (await res.json()) as { actors: DemoActor[] };
        if (!cancelled) setActors(data.actors);
      } catch {
        /* API not running yet */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A token can be revoked or expire while the tab is open. Ask the API who we
  // are and drop the session if the answer is "nobody".
  useEffect(() => {
    const token = session?.token;
    if (!ready || !token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/session', { headers: { authorization: `Bearer ${token}` } });
        if (res.ok || cancelled) return;
        const next = { ...session } as Session;
        delete next.token;
        delete next.expiresAt;
        delete next.actorId;
        setSessionState(next.demoBinding ? next : null);
        persist(next.demoBinding ? next : null);
      } catch {
        /* offline: keep the session; the next write will fail loudly */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session?.token]);

  const walletAvailable = useCallback((walletId = 'phantom') => Boolean(detectWallet(walletId)), []);

  const signInWithWallet = useCallback<SessionState['signInWithWallet']>(async (input) => {
    setPending(true);
    setLastWalletId(input.walletId);
    try {
      let address: string;
      let nonce: string;
      let signature: string;
      let message = '';

      if (input.reuse) {
        ({ address, nonce, signature } = input.reuse);
      } else {
        const connected = await connectWallet(input.walletId);
        address = connected.address;

        const challengeRes = await fetch('/api/auth/challenge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ walletAddress: address }),
        });
        const challenge = (await challengeRes.json()) as {
          nonce?: string;
          message?: string;
          error?: { message?: string };
        };
        if (!challengeRes.ok || !challenge.nonce || !challenge.message) {
          throw new Error(challenge.error?.message ?? 'Could not start the sign-in challenge');
        }
        nonce = challenge.nonce;
        message = challenge.message;
        signature = await signChallenge(connected.provider, message);
      }

      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          walletAddress: address,
          nonce,
          signature,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.role ? { role: input.role } : {}),
          ...(input.countryCode ? { countryCode: input.countryCode } : {}),
          ...(input.email ? { email: input.email } : {}),
        }),
      });
      const verified = (await verifyRes.json()) as {
        token?: string;
        expiresAt?: string;
        actor?: { id?: string };
        error?: { code?: string; message?: string };
      };

      if (verifyRes.status === 400 && verified.error?.code === 'PROFILE_REQUIRED') {
        // The nonce is NOT burned: the dialog can collect a display name and
        // resubmit this exact signature.
        throw new ProfileRequiredError(input.walletId, address, { nonce, message }, signature);
      }
      if (!verifyRes.ok || !verified.token || !verified.actor?.id) {
        throw new Error(verified.error?.message ?? 'The signature was rejected');
      }

      const next: Session = {
        method: 'wallet',
        label: truncateAddress(address),
        address,
        actorId: verified.actor.id,
        token: verified.token,
        expiresAt: verified.expiresAt,
        demoBinding: false,
      };
      setSessionState(next);
      persist(next);
      return next;
    } finally {
      setPending(false);
    }
  }, []);

  const signInWithDemoActor = useCallback<SessionState['signInWithDemoActor']>(async (actor) => {
    const next: Session = {
      method: 'demo',
      label: actor?.displayName ?? 'Demo browsing',
      actorId: actor?.id,
      demoBinding: true,
    };
    setSessionState(next);
    persist(next);
  }, []);

  const signInLocal = useCallback<SessionState['signInLocal']>(async (method) => {
    const next: Session = {
      method,
      label: method === 'google' ? 'you@gmail.com' : '@you',
      demoBinding: true,
    };
    setSessionState(next);
    persist(next);
  }, []);

  const signOut = useCallback(() => {
    const token = session?.token;
    if (token) void fetch('/api/auth/signout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    persist(null);
    setSessionState(null);
  }, [session?.token]);

  const bindActor = useCallback((id: string | null) => {
    setSessionState((current) => {
      if (!id) {
        if (!current) return current;
        const { actorId: _dropped, ...rest } = current;
        persist(rest);
        return rest;
      }
      const next: Session = {
        method: current?.method ?? 'demo',
        label: current?.label ?? 'Demo actor',
        address: current?.address,
        token: current?.token,
        expiresAt: current?.expiresAt,
        demoBinding: current?.token ? false : true,
        actorId: id,
      };
      persist(next);
      return next;
    });
  }, []);

  const actor = useMemo(() => actors.find((a) => a.id === session?.actorId) ?? null, [actors, session?.actorId]);

  const authHeaders = useCallback((): Record<string, string> => {
    if (session?.token) return { authorization: `Bearer ${session.token}` };
    if (session?.actorId && session.demoBinding) return { 'x-actor-id': session.actorId };
    return {};
  }, [session?.token, session?.actorId, session?.demoBinding]);

  return (
    <SessionContext.Provider
      value={{
        session,
        ready,
        pending,
        lastWalletId,
        signInWithWallet,
        signInWithDemoActor,
        signInLocal,
        signOut,
        walletAvailable,
        authHeaders,
        actors,
        actor,
        bindActor,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}

export { WalletUnavailableError };
