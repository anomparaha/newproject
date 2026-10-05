'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DemoActor } from '@/lib/api';

/**
 * Session shape for the web app.
 *
 * This is a LOCAL MOCK, deliberately. The backend still authenticates with the
 * `x-actor-id` header, so a button that pretended to sign a real challenge
 * would be a lie. What the picker really does is bind this browser to a demo
 * actor (the same thing the persona selector did), and it is labelled as such
 * in the UI. Swapping the body of `signIn` for Sign-In With Solana is the step
 * that turns this into real authentication.
 */
export interface Session {
  /** How the user got in. */
  method: 'google' | 'x' | 'wallet' | 'demo';
  /** Display label, e.g. a truncated wallet address or an email. */
  label: string;
  /** Wallet address when the method is `wallet`. */
  address?: string;
  /** Bound demo actor, when the sign-in was performed in demo mode. */
  actorId?: string;
}

const STORAGE_KEY = 'vin.session';

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

/**
 * Mock wallet addresses. Real ones arrive when a wallet adapter is wired in;
 * until then the UI must not imply a key was used.
 */
const MOCK_WALLETS = [
  { name: 'Phantom', address: '4Nd1mYQ9oEcrMnbFh4pYZoGk1xLQ2v7Tn3sWq8CbZaKd' },
  { name: 'Solflare', address: '7cVrFhx2TmPq9ZgL4yNbE6sDk3Wj8RpQ1uXvHa5MnTf' },
  { name: 'Backpack', address: '9KpLmQ3xWbYt6RvN2sEfHo8JdUcZ5aGq4TnXh7MpBsVr' },
];

export const MOCK_TRUNCATE = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;

interface SessionState {
  session: Session | null;
  ready: boolean;
  /** True while a mock handshake animation runs. */
  pending: Session['method'] | null;
  signIn: (method: Session['method'], detail?: { label?: string; address?: string; actorId?: string }) => Promise<void>;
  signOut: () => void;
  /** Demo actors the API exposes (used to bind a browser to an actor). */
  actors: DemoActor[];
  /** The demo actor bound to this browser, resolved from the session. */
  actor: DemoActor | null;
  /** Bind this browser to a demo actor (what the dialog's demo picker does). */
  bindActor: (id: string | null) => void;
}


const SessionContext = createContext<SessionState>({
  session: null,
  ready: false,
  pending: null,
  signIn: async () => undefined,
  signOut: () => undefined,
  actors: [],
  actor: null,
  bindActor: () => undefined,
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<Session['method'] | null>(null);
  const [actors, setActors] = useState<DemoActor[]>([]);

  useEffect(() => {
    setSessionState(readStored());
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

  const signIn = useCallback<SessionState['signIn']>(async (method, detail) => {
    setPending(method);
    try {
      if (method === 'wallet') {
        // A wallet handshake is interactive; keep a short delay so the button
        // reads as "connecting" instead of "done before you looked".
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
      const label =
        detail?.label ??
        (method === 'wallet'
          ? MOCK_TRUNCATE(detail?.address ?? MOCK_WALLETS[0]?.address ?? '')
          : method === 'google'
            ? 'you@gmail.com'
            : method === 'x'
              ? '@you'
              : 'Demo actor');
      const next: Session = { method, label, address: detail?.address, actorId: detail?.actorId };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSessionState(next);
    } finally {
      setPending(null);
    }
  }, []);

  const signOut = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setSessionState(null);
  }, []);

  const bindActor = useCallback((id: string | null) => {
    setSessionState((current) => {
      if (!id) {
        // Keep the sign-in method, drop the bound actor.
        if (!current) return current;
        const { actorId: _dropped, ...rest } = current;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
        return rest;
      }
      const next: Session = { method: current?.method ?? 'demo', label: current?.label ?? 'Demo actor', address: current?.address, actorId: id };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const actor = useMemo(() => actors.find((a) => a.id === session?.actorId) ?? null, [actors, session?.actorId]);

  return (
    <SessionContext.Provider value={{ session, ready, pending, signIn, signOut, actors, actor, bindActor }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}

export { MOCK_WALLETS };
