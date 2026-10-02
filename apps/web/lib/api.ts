import type { Actor, Corridor, CorridorMetrics, Deal, Dispute, Escrow, InspectionReport, Listing, VinEvent } from '@vin/shared';

/** Server-side only (React Server Components). The browser always uses the relative /api/* routes. */
const API_ORIGIN = process.env.VIN_API_URL ?? 'http://127.0.0.1:8080';

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_ORIGIN}${path}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface MetaPolicy {
  platform: string;
  whatItIs: string;
  moneyRule: string;
  disclaimers: Record<string, string>;
  fees: Record<string, unknown>;
  bonds: Record<string, unknown>;
  capacity: Record<string, unknown>;
  token: { functions: string[]; neverDoes: string[] };
  tokenMetricsNote: string;
  haltThresholds: Record<string, number>;
  stages: Array<{ id: string; label: string; allowed: string[]; forbidden: string[] }>;
  publicMetrics: string[];
  eventTypes: Array<{ type: string; label: string; category: string }>;
  vinNotice: string;
}

export interface TokenMetrics {
  lockBonds: Array<{ currency: string; amount: string }>;
  activeStakeholders: number;
  bondsSlashed: number;
  bondsReturned: number;
  note: string;
}

export interface VinPage {
  vin: string;
  notice: string;
  listings: Listing[];
  reports: Array<InspectionReport & { checklist: Record<string, boolean> }>;
  notes: Array<{ id: string; vin: string; status: string; priceAmount: string; priceCurrency: string; evidenceRoot: string; createdAt: string }>;
  events: VinEvent[];
  anomalies: VinEvent[];
  lastOdometer: { km: number; eventId: string } | null;
  claimsBoundary: string;
  ifNoData: string | null;
}

export interface DealPage {
  deal: Deal;
  escrows: Escrow[];
  reports: Array<InspectionReport & { checklist: Record<string, boolean> }>;
  dispute: Dispute | null;
  note: { id: string; evidenceRoot: string; status: string; escrowTxId: string | null } | null;
  parties: { buyer: Actor | null; seller: Actor | null; inspector: Actor | null };
  events: VinEvent[];
}

export interface InspectorEntry {
  actor: Actor;
  bond: { amount: string; currency: string };
  reputation: {
    dealsCompleted: number;
    disputesOpened: number;
    disputesLost: number;
    onTimeReportRate: number | null;
    standardComplianceRate: number | null;
    medianReportHours: number | null;
    listedInRanking: boolean;
  } | null;
  score: number;
}

export interface DemoActor {
  id: string;
  role: string;
  displayName: string;
  countryCode: string;
  verification: string;
}

export const api = {
  policy: () => apiGet<MetaPolicy>('/api/meta/policy'),
  tokenMetrics: () => apiGet<TokenMetrics>('/api/metrics/token'),
  listings: () => apiGet<{ listings: Listing[]; corridor: Corridor; candidateCorridors: Array<{ originCountry: string; destinationCountry: string; reason: string }> }>('/api/listings'),
  listing: (id: string) => apiGet<{ listing: Listing; seller: Actor | null; vinNotice: string }>(`/api/listings/${id}`),
  vin: (vin: string) => apiGet<VinPage>(`/api/vin/${vin}`),
  deal: (id: string) => apiGet<DealPage>(`/api/deals/${id}`),
  deals: (actorId?: string) => apiGet<{ deals: Deal[] }>(`/api/deals${actorId ? `?actorId=${actorId}` : ''}`),
  inspectors: (country?: string) => apiGet<{ inspectors: InspectorEntry[]; note: string; rankingPolicy: string }>(`/api/inspectors${country ? `?country=${country}` : ''}`),
  corridors: () => apiGet<{ corridors: Corridor[]; candidateCorridors: Array<{ originCountry: string; destinationCountry: string; reason: string }> }>('/api/corridors'),
  corridorMetrics: (id: string) => apiGet<{ metrics: CorridorMetrics; halt: { halted: boolean; reasons: string[] } }>(`/api/corridors/${id}/metrics`),
  actors: () => apiGet<{ actors: Actor[] }>('/api/actors'),
  actor: (id: string) => apiGet<{ actor: Actor; bonds: Array<{ id: string; amount: string; currency: string; state: string; purpose: string }>; reputation: Record<string, unknown> | null }>(`/api/actors/${id}`),
  demoActors: () => apiGet<{ demoMode: boolean; actors: DemoActor[]; warning: string }>('/api/demo/actors'),
};
