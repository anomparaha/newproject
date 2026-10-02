'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DemoActor } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/format';

const STORAGE_KEY = 'vin.persona';

interface PersonaState {
  actors: DemoActor[];
  actorId: string | null;
  actor: DemoActor | null;
  setActorId: (id: string | null) => void;
  loading: boolean;
  demoMode: boolean;
}

const PersonaContext = createContext<PersonaState>({
  actors: [],
  actorId: null,
  actor: null,
  setActorId: () => undefined,
  loading: true,
  demoMode: true,
});

export function PersonaProvider({ children }: { children: ReactNode }) {
  const [actors, setActors] = useState<DemoActor[]>([]);
  const [actorId, setActorIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoMode, setDemoMode] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/demo/actors');
        if (res.ok) {
          const data = (await res.json()) as { actors: DemoActor[]; demoMode: boolean };
          if (!cancelled) {
            setActors(data.actors);
            setDemoMode(data.demoMode);
          }
        }
      } catch {
        /* API is not running yet: leave the list empty */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) setActorIdState(stored);
    return () => {
      cancelled = true;
    };
  }, []);

  const setActorId = useCallback((id: string | null) => {
    setActorIdState(id);
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  const value = useMemo<PersonaState>(() => {
    const actor = actors.find((a) => a.id === actorId) ?? null;
    return { actors, actorId, actor, setActorId, loading, demoMode };
  }, [actors, actorId, setActorId, loading, demoMode]);

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
}

export function usePersona(): PersonaState {
  return useContext(PersonaContext);
}

export function PersonaPicker() {
  const { actors, actor, actorId, setActorId, loading, demoMode } = usePersona();

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[0.68rem] uppercase tracking-wider text-mist-400">Demo persona</span>
        {actor ? (
          <span className="chip text-signal border-signal/40">{ROLE_LABEL[actor.role] ?? actor.role}</span>
        ) : null}
      </div>
      <select
        value={actorId ?? ''}
        disabled={loading || actors.length === 0}
        onChange={(event) => setActorId(event.target.value || null)}
        aria-label="Select persona"
      >
        <option value="">
          {loading ? 'Loading…' : actors.length === 0 ? 'Backend not running' : 'Select an actor…'}
        </option>
        {actors.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName} — {ROLE_LABEL[a.role] ?? a.role}
          </option>
        ))}
      </select>
      <p className="mt-2 text-[0.68rem] leading-relaxed text-mist-400">
        {demoMode
          ? 'Button actions carry the x-actor-id header for the selected persona. In production, identity comes from Sign-In With Solana plus attestation.'
          : 'Demo mode is off.'}
      </p>
    </div>
  );
}
