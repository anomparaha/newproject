/**
 * VIN deal state machine.
 *
 * Only EVENTS move the state; nothing else silently updates a column. Every
 * function here is pure, so the API, the frontend, and the tests can all use it
 * without a database.
 */

import type { DealState, EventType } from './types.js';

export type DealAction =
  | 'seller_listed'
  | 'buyer_commits_and_funds'
  | 'escrow_funded'
  | 'inspector_uploads_report'
  | 'buyer_accepts_report'
  | 'deadline_elapsed'
  | 'handover_confirmed'
  | 'vehicle_released'
  | 'open_dispute'
  | 'arbiter_resolves_refund'
  | 'arbiter_resolves_release'
  | 'cancel_before_funding';

interface TransitionRule {
  from: DealState[];
  to: DealState;
  actor: 'seller' | 'buyer' | 'inspector' | 'platform' | 'arbiter';
}

export const DEAL_TRANSITIONS: Record<DealAction, TransitionRule> = {
  seller_listed: { from: ['draft'], to: 'draft', actor: 'seller' },
  buyer_commits_and_funds: { from: ['draft'], to: 'escrow_pending', actor: 'buyer' },
  escrow_funded: { from: ['escrow_pending'], to: 'inspecting', actor: 'platform' },
  inspector_uploads_report: { from: ['inspecting'], to: 'inspecting', actor: 'inspector' },
  buyer_accepts_report: { from: ['inspecting'], to: 'inspection_accepted', actor: 'buyer' },
  // Concept §3: if nobody accepts or rejects the report in time, inspection funds
  // may still release once the report meets the standard.
  deadline_elapsed: { from: ['inspecting'], to: 'inspection_accepted', actor: 'platform' },
  handover_confirmed: { from: ['inspection_accepted'], to: 'handover_pending', actor: 'buyer' },
  vehicle_released: { from: ['handover_pending'], to: 'completed', actor: 'platform' },
  open_dispute: {
    from: ['escrow_pending', 'inspecting', 'inspection_accepted', 'handover_pending'],
    to: 'frozen',
    actor: 'buyer',
  },
  arbiter_resolves_refund: { from: ['frozen'], to: 'cancelled', actor: 'arbiter' },
  arbiter_resolves_release: { from: ['frozen'], to: 'completed', actor: 'arbiter' },
  cancel_before_funding: { from: ['escrow_pending'], to: 'cancelled', actor: 'platform' },
};

export interface TransitionCheck {
  ok: boolean;
  state: DealState;
  reason?: string;
}

export function canTransition(current: DealState, action: DealAction): TransitionCheck {
  const rule = DEAL_TRANSITIONS[action];
  if (!rule) {
    return { ok: false, state: current, reason: `Unknown action: ${action}` };
  }
  if (current === 'frozen' && action !== 'arbiter_resolves_refund' && action !== 'arbiter_resolves_release') {
    return {
      ok: false,
      state: current,
      reason: 'Escrow and receipt are frozen. An arbitration ruling is required before anything else.',
    };
  }
  if (rule.from.includes(current)) {
    return { ok: true, state: rule.to, reason: undefined };
  }
  return {
    ok: false,
    state: current,
    reason: `Cannot run "${action}" from state ${current}.`,
  };
}

/** Events that MUST exist before vehicle funds may be released (control §10). */
export function vehicleReleasePreconditions(input: {
  handoverTerms: string;
  confirmedBy: string[];
  buyerId: string;
  sellerId: string;
  disputeOpen: boolean;
}): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (input.disputeOpen) missing.push('dispute_still_open');
  if (input.confirmedBy.length === 0) {
    missing.push('handover_terms_not_confirmed');
  }
  const needsBoth = input.handoverTerms.toLowerCase().includes('both parties');
  if (needsBoth) {
    if (!input.confirmedBy.includes(input.buyerId)) missing.push('buyer_confirmation');
    if (!input.confirmedBy.includes(input.sellerId)) missing.push('seller_confirmation');
  }
  return { ok: missing.length === 0, missing };
}

/** Events that MUST exist before inspection funds may be released. */
export function inspectionReleasePreconditions(input: {
  reportUploaded: boolean;
  reportMeetsStandard: boolean;
  buyerAccepted: boolean;
  deadlineElapsed: boolean;
}): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!input.reportUploaded) missing.push('report_not_uploaded');
  if (!input.reportMeetsStandard) missing.push('report_below_standard');
  if (!input.buyerAccepted && !input.deadlineElapsed) {
    missing.push('buyer_has_not_accepted_and_deadline_not_passed');
  }
  return { ok: missing.length === 0, missing };
}

/** An odometer anomaly never auto-rejects a deal — it is a warning only. */
export function odometerIsAnomaly(currentKm: number, previousKm: number | null): boolean {
  if (previousKm === null) return false;
  return currentKm < previousKm;
}

export function eventForAction(action: DealAction): EventType | null {
  switch (action) {
    case 'buyer_commits_and_funds':
      return 'deal_committed';
    case 'inspector_uploads_report':
      return 'report_uploaded';
    case 'buyer_accepts_report':
      return 'inspection_funds_released';
    case 'vehicle_released':
      return 'vehicle_funds_released';
    case 'open_dispute':
      return 'dispute_opened';
    case 'arbiter_resolves_refund':
    case 'arbiter_resolves_release':
      return 'dispute_resolved';
    default:
      return null;
  }
}

export const DEAL_STATE_LABEL: Record<DealState, string> = {
  draft: 'Draft — listing is live, no buyer yet',
  escrow_pending: 'Escrow awaiting funding',
  inspecting: 'Inspection in progress',
  inspection_accepted: 'Report accepted, waiting for handover',
  handover_pending: 'Handover confirmed, waiting for fund release',
  completed: 'Completed — receipt recorded',
  frozen: 'Frozen — dispute in progress',
  cancelled: 'Cancelled',
};
