/**
 * Implementasi escrow.
 *
 * MVP: MockEscrowProvider - meniru ledger escrow (rekening bersama / PJP berizin).
 * Skala: AnchorEscrowProvider - program Solana (Rust + Anchor) dengan vault PDA dan USDC.
 *
 * Keduanya memenuhi kontrak `EscrowProvider` yang sama sehingga logika deal tidak
 * perlu berubah saat pindah ke on-chain.
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
    if (!escrow) throw new Error(`Escrow ${escrowId} tidak ditemukan`);
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
    if (!escrow) throw new Error(`Escrow ${escrowId} tidak ditemukan`);
    if (escrow.status === 'frozen') throw new Error('Escrow dibekukan: keputusan arbitrase diperlukan.');
    if (opts.evidenceEventIds.length === 0) {
      throw new Error('Pelepasan dana wajib merujuk bukti event (tanpa bukti, dana tidak cair).');
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
      JSON.stringify({ amount, rateToDisputeFundBps, note: 'Potongan masuk kas sengketa, bukan dompet tim.' }),
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
      throw new Error('Pelepasan sebagian wajib merujuk bukti event.');
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
   * Pindahkan dana dari escrow yang (mungkin) sedang DIBEKUKAN, atas dasar
   * putusan arbitrase. Meniru `resolve_dispute` pada program Anchor.
   */
  async resolveByArbitration(
    escrowId: string,
    input: { decision: DisputeOutcome; toBuyer: string; toCounterparty: string; evidenceEventIds: string[] },
  ): Promise<{ escrowId: string; status: EscrowStatus; txRef: string; releasedAt: string; toBuyer: string; toCounterparty: string }> {
    const escrow = this.findById(escrowId);
    if (!escrow) throw new Error(`Escrow ${escrowId} tidak ditemukan`);
    if (escrow.status === 'released' || escrow.status === 'refunded' || escrow.status === 'partially_released') {
      throw new Error('Escrow sudah diselesaikan; putusan arbitrase tidak bisa dijalankan dua kali.');
    }
    if (input.evidenceEventIds.length === 0) {
      throw new Error('Putusan arbitrase wajib merujuk bukti event.');
    }
    const toBuyer = Number(input.toBuyer);
    const toCounterparty = Number(input.toCounterparty);
    const amount = Number(escrow.amount);
    if (toBuyer + toCounterparty > amount) {
      throw new Error('Putusan melebihi jumlah yang ada di escrow (dana tidak boleh diciptakan).');
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
              ? 'Bengkel dibayar bila laporan sudah diunggah; sisanya kembali ke pembeli.'
              : 'Leg kendaraan mengikuti putusan arbiter.',
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
 * Stub program on-chain. Aktifkan setelah `programs/vin_anchor` di-deploy dan
 * `VIN_ESCROW_PROGRAM_ID` diset. Belum ada implementasi agar tidak ada klaim palsu
 * tentang dana yang benar-benar on-chain.
 */
export class AnchorEscrowProvider implements EscrowProvider {
  readonly kind: EscrowProviderKind = 'anchor_solana';

  constructor(private readonly rpcUrl: string, private readonly programId: string) {}

  private notReady(): never {
    throw new Error(
      `AnchorEscrowProvider belum diaktifkan (rpc=${this.rpcUrl}, program=${this.programId}). ` +
        'Jalankan: anchor build && anchor deploy, lalu set VIN_ESCROW_PROGRAM_ID. ' +
        'Sampai itu terjadi, dana TIDAK boleh diklaim on-chain.',
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
