/**
 * Event log append-only per VIN.
 *
 * Satu VIN memiliki RANGKAIAN event, bukan satu berkas yang diedit.
 * Tidak ada fungsi di file ini yang boleh mengubah atau menghapus event lama.
 */

import type { DatabaseSync } from 'node:sqlite';
import { EVENT_META, type EventPayload, type EventType, type Role, type VinEvent } from '@vin/shared';
import { all, get, json, newId, nowIso, run } from './db.js';

export interface AppendEventInput {
  vin: string;
  type: EventType;
  dealId?: string | null;
  payload?: EventPayload;
  actorId?: string | null;
  actorRole?: Role | null;
  /** Ditulis setelah program Solana mengkonfirmasi anchor hash. */
  anchorSignature?: string | null;
  createdAt?: string;
}

export function appendEvent(db: DatabaseSync, input: AppendEventInput): VinEvent {
  const meta = EVENT_META[input.type];
  if (!meta) throw new Error(`Tipe event tidak sah: ${input.type}`);

  const row = get(db, 'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE vin = ?', [input.vin]);
  const seq = Number(row?.max_seq ?? 0) + 1;
  const createdAt = input.createdAt ?? nowIso();
  const event: VinEvent = {
    id: newId('evt'),
    vin: input.vin,
    seq,
    type: input.type,
    category: meta.category,
    dealId: input.dealId ?? null,
    payload: input.payload ?? {},
    anchorSignature: input.anchorSignature ?? null,
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    createdAt,
  };

  run(
    db,
    `INSERT INTO events (id, vin, seq, type, category, deal_id, payload, anchor_signature, actor_id, actor_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.vin,
      event.seq,
      event.type,
      event.category,
      event.dealId,
      JSON.stringify(event.payload),
      event.anchorSignature,
      event.actorId,
      event.actorRole,
      event.createdAt,
    ],
  );

  // Perbarui proyeksi listing hanya untuk keperluan tampilan pencarian.
  // Proyeksi tidak menggantikan event: bila proyeksi rusak, bisa dibangun ulang.
  if (input.type === 'deal_committed') {
    run(db, 'UPDATE listings SET status = ?, updated_at = ? WHERE vin = ? AND status = ?', [
      'reserved',
      createdAt,
      input.vin,
      'listed',
    ]);
  }
  if (input.type === 'note_completed') {
    run(db, 'UPDATE listings SET status = ?, updated_at = ? WHERE vin = ?', ['completed', createdAt, input.vin]);
  }
  if (input.type === 'dispute_opened') {
    run(db, 'UPDATE listings SET status = ?, updated_at = ? WHERE vin = ?', ['disputed', createdAt, input.vin]);
  }

  return event;
}

function rowToEvent(row: Record<string, unknown>): VinEvent {
  return {
    id: String(row.id),
    vin: String(row.vin),
    seq: Number(row.seq),
    type: String(row.type) as EventType,
    category: String(row.category) as VinEvent['category'],
    dealId: row.deal_id === null ? null : String(row.deal_id),
    payload: json<EventPayload>(row.payload as string, {}),
    anchorSignature: row.anchor_signature === null ? null : String(row.anchor_signature),
    actorId: row.actor_id === null ? null : String(row.actor_id),
    actorRole: row.actor_role === null ? null : (String(row.actor_role) as Role),
    createdAt: String(row.created_at),
  };
}

export function eventsForVin(db: DatabaseSync, vin: string): VinEvent[] {
  return all(db, 'SELECT * FROM events WHERE vin = ? ORDER BY seq ASC', [vin]).map(rowToEvent);
}

export function eventsForDeal(db: DatabaseSync, dealId: string): VinEvent[] {
  return all(db, 'SELECT * FROM events WHERE deal_id = ? ORDER BY seq ASC', [dealId]).map(rowToEvent);
}

export function eventsByType(db: DatabaseSync, vin: string, type: EventType): VinEvent[] {
  return eventsForVin(db, vin).filter((e) => e.type === type);
}

/**
 * Anomali kilometer: bila angka odometer lebih rendah dari catatan terakhir pada
 * VIN yang sama, sistem menandai anomali - bukan menolak otomatis.
 */
export function latestOdometer(db: DatabaseSync, vin: string): { km: number; eventId: string } | null {
  const rows = all(
    db,
    `SELECT id, payload FROM events WHERE vin = ? AND type IN ('report_uploaded','listing_created') ORDER BY seq DESC`,
    [vin],
  );
  for (const row of rows) {
    const payload = json<EventPayload>(row.payload as string, {});
    if (typeof payload.odometerKm === 'number') {
      return { km: payload.odometerKm, eventId: String(row.id) };
    }
  }
  return null;
}

export function timelineSummary(db: DatabaseSync, vin: string) {
  const events = eventsForVin(db, vin);
  const last = events.at(-1);
  return {
    vin,
    eventCount: events.length,
    lastEventType: last?.type ?? null,
    lastEventAt: last?.createdAt ?? null,
    anomalies: events.filter((e) => e.type === 'odometer_anomaly').length,
  };
}
