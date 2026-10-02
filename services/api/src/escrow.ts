/**
 * Implementasi escrow.
 *
 * MVP: MockEscrowProvider - meniru ledger escrow (rekening bersama / PJP berizin).
 * Scale: AnchorEscrowProvider - a Solana program (Rust + Anchor) with PDA vaults and USDC.
 *
 * Both honour the same `EscrowProvider` contract, so deal logic does not change
 * when the system moves on-chain.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  DisputeOutcome,
  Escrow,
  EscrowLeg,
  EscrowProvider,
  EscrowProviderKind,
  EscrowStatus,
  ReleaseTerms,
} from '@vin/shared';
import { all, get, json, newId, nowIso, run } from './db.js';

interface EscrowRow extends Record<string, unknown> {
  id: string;
  deal_id: string;
  leg: EscrowLeg;
  provider: EscrowProviderKind;
  amount: string;
  currency: string;
  status: EscrowStatus;
  release_terms: string;
  funded_at: string | null;
  released_at: string | null;
  tx_ref: string | null;
}

function rowToEscrow(row: EscrowRow): Escrow {
  return {
    id: row.id,
    dealId: row.deal_id,
    leg: row.leg,
    provider: row.provider,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    releaseTerms: json<ReleaseTerms>(row.release_terms, { vehicle: [], inspection: [] }),
    fundedAt: row.funded_at,
    releasedAt: row.released_at,
    txRef: row.tx_ref,
  };
}

export class MockEscrowProvider implements EscrowProvider {
  readonly kind: EscrowProviderKind = 'mock';

  constructor(private readonly db: DatabaseSync) {}

  async createEscrow(input: {
    dealId: string;
    leg: EscrowLeg;
    amount: string;
    currency: string;
    releaseTerms: ReleaseTerms;
  }): Promise<Escrow> {
    const existing = this.findByDealLeg(input.dealId, input.leg);
    if (existing) return existing;
    const id = newId('esc');
    const createdAt = nowIso();
    run(
      this.db,
      `INSERT INTO escrows (id, deal_id, leg, provider, amount, currency, status, release_terms, funded_at, released_at, tx_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?)`,
      [id, input.dealId, input.leg, this.kind, input.amount, input.currency, JSON.stringify(input.releaseTerms), createdAt],
    );
    return this.findById(id)!;
  }

  async fund(escrowId: string, payerRef: string): Promise<{ escrowId: string; status: EscrowStatus; txRef: string; fundedAt: string }> {
    const escrow = this.findById(escrowId);
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`);
    if (escrow.status === 'funded') {
      return { escrowId, status: 'funded', txRef: escrow.txRef ?? '', fundedAt: escrow.fundedAt ?? nowIso() };
    }
    const txRef = `mock_tx_fund_${newId('x')}_${payerRef.slice(0, 8)}`;
    const fundedAt = nowIso();
    run(this.db, 'UPDATE escrows SET status = ?, funded_at = ?, tx_ref = ? WHERE id = ?', [
      'funded',
      fundedAt,
      txRef,
      escrowId,
    ]);
    return { escrowId, status: 'funded', txRef, fundedAt };
  }

  async release(
    escrowId: string,
    opts: { recipientRef: string; evidenceEventIds: string[] },
  ): Promise<{ escrowId: string; status: EscrowStatus; txRef: string; releasedAt: string }> {
    const escrow = this.findById(escrowId);
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`);
    if (escrow.status === 'frozen') throw new Error('Escrow is frozen: an arbitration ruling is required.');
    if (opts.evidenceEventIds.length === 0) {
      throw new Error('A release must reference evidence events (without evidence, funds do not move).');
    }
    const txRef = `mock_tx_release_${newId('x')}`;
    const releasedAt = nowIso();
    run(this.db, 'UPDATE escrows SET status = ?, released_at = ?, tx_ref = ? WHERE id = ?', [
      'released',
      releasedAt,
      txRef,
      escrowId,
    ]);
    return { escrowId, status: 'released', txRef, releasedAt };
  }

  async freeze(escrowId: string, reason: string): Promise<{ escrowId: string; status: EscrowStatus; txRef: string }> {
    const txRef = `mock_tx_freeze_${newId('x')}`;
    run(this.db, 'UPDATE escrows SET status = ?, tx_ref = ? WHERE id = ?', ['frozen', txRef, escrowId]);
    run(this.db, 'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)', [
      newId('aud'),
      'escrow_freeze',
      null,
      'escrow',
      escrowId,
      reason,
      nowIso(),
    ]);
    return { escrowId, status: 'frozen', txRef };
  }

  async slash(
    escrowId: string,
    amount: string,
    rateToDisputeFundBps: number,
  ): Promise<{ escrowId: string; status: EscrowStatus; txRef: string; releasedAt: string }> {
    const txRef = `mock_tx_slash_${newId('x')}`;
    const releasedAt = nowIso();
    run(this.db, 'UPDATE escrows SET status = ?, released_at = ?, tx_ref = ? WHERE id = ?', [
      'slashed',
      releasedAt,
      txRef,
      escrowId,
    ]);
    run(this.db, 'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)', [
      newId('aud'),
      'bond_slashed',
      null,
      'escrow',
      escrowId,
      JSON.stringify({ amount, rateToDisputeFundBps, note: 'Slashed funds go to the dispute fund, not the team wallet.' }),
      nowIso(),
    ]);
    return { escrowId, status: 'slashed', txRef, releasedAt };
  }

  async refund(escrowId: string, reason: string): Promise<{ escrowId: string; status: EscrowStatus; txRef: string; releasedAt: string }> {
    const txRef = `mock_tx_refund_${newId('x')}`;
    const releasedAt = nowIso();
    run(this.db, 'UPDATE escrows SET status = ?, released_at = ?, tx_ref = ? WHERE id = ?', [
      'refunded',
      releasedAt,
      txRef,
      escrowId,
    ]);
    run(this.db, 'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)', [
      newId('aud'),
      'escrow_refund',
      null,
      'escrow',
      escrowId,
      reason,
      nowIso(),
    ]);
    return { escrowId, status: 'refunded', txRef, releasedAt };
  }

  async partialRelease(
    escrowId: string,
    parts: { toBuyer: string; toSeller: string },
    evidenceEventIds: string[],
  ): Promise<{ escrowId: string; status: EscrowStatus; txRef: string; releasedAt: string; toBuyer: string; toSeller: string }> {
    if (evidenceEventIds.length === 0) {
      throw new Error('A partial release must reference evidence events.');
    }
    const txRef = `mock_tx_split_${newId('x')}`;
    const releasedAt = nowIso();
    run(this.db, 'UPDATE escrows SET status = ?, released_at = ?, tx_ref = ? WHERE id = ?', [
      'partially_released',
      releasedAt,
      txRef,
      escrowId,
    ]);
    run(this.db, 'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)', [
      newId('aud'),
      'escrow_partial_release',
      null,
      'escrow',
      escrowId,
      JSON.stringify(parts),
      releasedAt,
    ]);
    return { escrowId, status: 'partially_released', txRef, releasedAt, ...parts };
  }

  /**
   * Move funds out of an escrow that may still be FROZEN, based on an
   * arbitration ruling. Mirrors `resolve_dispute` in the Anchor program.
   */
  async resolveByArbitration(
    escrowId: string,
    input: { decision: DisputeOutcome; toBuyer: string; toCounterparty: string; evidenceEventIds: string[] },
  ): Promise<{ escrowId: string; status: EscrowStatus; txRef: string; releasedAt: string; toBuyer: string; toCounterparty: string }> {
    const escrow = this.findById(escrowId);
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`);
    if (escrow.status === 'released' || escrow.status === 'refunded' || escrow.status === 'partially_released') {
      throw new Error('This escrow is already settled; an arbitration ruling cannot run twice.');
    }
    if (input.evidenceEventIds.length === 0) {
      throw new Error('An arbitration ruling must reference evidence events.');
    }
    const toBuyer = Number(input.toBuyer);
    const toCounterparty = Number(input.toCounterparty);
    const amount = Number(escrow.amount);
    if (toBuyer + toCounterparty > amount) {
      throw new Error('The ruling exceeds the escrow balance (money cannot be created).');
    }
    const status: EscrowStatus =
      toBuyer > 0 && toCounterparty > 0 ? 'partially_released' : toCounterparty > 0 ? 'released' : 'refunded';
    const txRef = `mock_tx_arbitration_${newId('x')}`;
    const releasedAt = nowIso();
    run(this.db, 'UPDATE escrows SET status = ?, released_at = ?, tx_ref = ? WHERE id = ?', [
      status,
      releasedAt,
      txRef,
      escrowId,
    ]);
    run(
      this.db,
      'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)',
      [
        newId('aud'),
        'escrow_arbitration_settlement',
        null,
        'escrow',
        escrowId,
        JSON.stringify({
          decision: input.decision,
          toBuyer: input.toBuyer,
          toCounterparty: input.toCounterparty,
          leg: escrow.leg,
          note:
            escrow.leg === 'inspection'
              ? 'The workshop is paid once a report was uploaded; the remainder goes back to the buyer.'
              : 'The vehicle leg follows the arbiter ruling.',
        }),
        releasedAt,
      ],
    );
    return { escrowId, status, txRef, releasedAt, toBuyer: input.toBuyer, toCounterparty: input.toCounterparty };
  }

  findById(id: string): Escrow | null {
    const row = get(this.db, 'SELECT * FROM escrows WHERE id = ?', [id]) as EscrowRow | undefined;
    return row ? rowToEscrow(row) : null;
  }

  findByDealLeg(dealId: string, leg: EscrowLeg): Escrow | null {
    const row = get(this.db, 'SELECT * FROM escrows WHERE deal_id = ? AND leg = ?', [dealId, leg]) as
      | EscrowRow
      | undefined;
    return row ? rowToEscrow(row) : null;
  }

  listForDeal(dealId: string): Escrow[] {
    return (all(this.db, 'SELECT * FROM escrows WHERE deal_id = ? ORDER BY leg', [dealId]) as EscrowRow[]).map(rowToEscrow);
  }
}

/**
 * On-chain program stub. Enable it after `programs/vin_anchor` is deployed and
 * `VIN_ESCROW_PROGRAM_ID` is set. There is no implementation yet on purpose, so
 * nobody can falsely claim funds really sit on-chain.
 */
export class AnchorEscrowProvider implements EscrowProvider {
  readonly kind: EscrowProviderKind = 'anchor_solana';

  constructor(private readonly rpcUrl: string, private readonly programId: string) {}

  private notReady(): never {
    throw new Error(
      `AnchorEscrowProvider is not enabled yet (rpc=${this.rpcUrl}, program=${this.programId}). ` +
        'Run: anchor build && anchor deploy, then set VIN_ESCROW_PROGRAM_ID. ' +
        'Until then, funds must NOT be described as on-chain.',
    );
  }

  async createEscrow(): Promise<Escrow> {
    this.notReady();
  }
  async fund(): Promise<never> {
    this.notReady();
  }
  async release(): Promise<never> {
    this.notReady();
  }
  async freeze(): Promise<never> {
    this.notReady();
  }
  async slash(): Promise<never> {
    this.notReady();
  }
  async refund(): Promise<never> {
    this.notReady();
  }
  async partialRelease(): Promise<never> {
    this.notReady();
  }
  async resolveByArbitration(): Promise<never> {
    this.notReady();
  }
}
