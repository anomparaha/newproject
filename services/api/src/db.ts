/**
  * The MVP database uses `node:sqlite` (built into Node 22), so:
 *  - no database server needs to run just to ship to Solana/Vercel,
  *  - it can move to Postgres in production (the schema is portable by design).
 *
 * Schema rule: `events` is APPEND-ONLY. No UPDATE or DELETE ever touches that table.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILOT_CORRIDOR } from './policy.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');
const DEFAULT_DB = resolve(REPO_ROOT, '.data/vin.db');

export function dbPath(): string {
  return process.env.VIN_DB_PATH ?? DEFAULT_DB;
}

export function openDb(path = dbPath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  ensureDefaultCorridor(db);
  return db;
}

/**
 * The pilot corridor is written idempotently when the database opens, so listings
 * created before the corridor existed still have a valid reference.
 */
function ensureDefaultCorridor(db: DatabaseSync): void {
  const exists = db.prepare('SELECT id FROM corridors WHERE id = ?').get(PILOT_CORRIDOR.id);
  if (exists) return;
  db.prepare(
    `INSERT INTO corridors (id, origin_country, destination_country, min_vehicle_price_usd, allowed_currencies, status, opened_at)
     VALUES (?, ?, ?, ?, ?, 'pilot', ?)`,
  ).run(
    PILOT_CORRIDOR.id,
    PILOT_CORRIDOR.originCountry,
    PILOT_CORRIDOR.destinationCountry,
    PILOT_CORRIDOR.minVehiclePriceUsd,
    JSON.stringify(PILOT_CORRIDOR.allowedCurrencies),
    PILOT_CORRIDOR.openedAt,
  );
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS actors (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('buyer','seller','inspector','curator','arbiter')),
      display_name TEXT NOT NULL,
      email TEXT NOT NULL,
      wallet_address TEXT,
      payout_address TEXT,
      verification TEXT NOT NULL DEFAULT 'none',
      country_code TEXT NOT NULL,
      city TEXT,
      base_currency TEXT NOT NULL DEFAULT 'USDC',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS corridors (
      id TEXT PRIMARY KEY,
      origin_country TEXT NOT NULL,
      destination_country TEXT NOT NULL,
      min_vehicle_price_usd REAL NOT NULL,
      allowed_currencies TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pilot',
      opened_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      vin TEXT NOT NULL,
      seller_id TEXT NOT NULL REFERENCES actors(id),
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER NOT NULL,
      odometer_km INTEGER,
      location TEXT NOT NULL,
      price_amount TEXT NOT NULL,
      price_currency TEXT NOT NULL,
      price_usd REAL NOT NULL,
      shipping_terms TEXT NOT NULL,
      photo_hashes TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'listed',
      bond_amount TEXT NOT NULL DEFAULT '0',
      bond_currency TEXT NOT NULL DEFAULT 'VIN',
      corridor_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listings_vin ON listings(vin);

    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES listings(id),
      vin TEXT NOT NULL,
      buyer_id TEXT NOT NULL REFERENCES actors(id),
      seller_id TEXT NOT NULL REFERENCES actors(id),
      inspector_id TEXT NOT NULL REFERENCES actors(id),
      state TEXT NOT NULL,
      price_amount TEXT NOT NULL,
      price_currency TEXT NOT NULL,
      shipping_paid_by TEXT NOT NULL,
      shipping_amount TEXT NOT NULL,
      inspection_fee_amount TEXT NOT NULL,
      inspection_fee_currency TEXT NOT NULL DEFAULT 'USDC',
      escrow_ref_vehicle TEXT,
      escrow_ref_inspection TEXT,
      inspection_released_at TEXT,
      vehicle_released_at TEXT,
      inspection_deadline TEXT NOT NULL,
      handover_terms TEXT NOT NULL,
      handover_confirmed_by TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deals_vin ON deals(vin);

    -- APPEND-ONLY. Old events are never overwritten.
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      vin TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      deal_id TEXT,
      payload TEXT NOT NULL,
      anchor_signature TEXT,
      actor_id TEXT,
      actor_role TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (vin, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_events_vin ON events(vin, seq);

    CREATE TABLE IF NOT EXISTS escrows (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id),
      leg TEXT NOT NULL CHECK (leg IN ('vehicle','inspection')),
      provider TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      release_terms TEXT NOT NULL,
      funded_at TEXT,
      released_at TEXT,
      tx_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (deal_id, leg)
    );

    CREATE TABLE IF NOT EXISTS inspection_reports (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id),
      vin TEXT NOT NULL,
      inspector_id TEXT NOT NULL,
      odometer_km INTEGER NOT NULL,
      inspected_at TEXT NOT NULL,
      report_hash TEXT NOT NULL,
      dashboard_photo_hash TEXT NOT NULL,
      condition_summary TEXT NOT NULL,
      standard_version TEXT NOT NULL,
      checklist TEXT NOT NULL,
      anomaly INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id),
      opened_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      outcome TEXT,
      arbiter_id TEXT,
      bond_slashed_amount TEXT,
      refunded_amount TEXT,
      released_amount TEXT,
      arbiter_note TEXT,
      opened_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bonds (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL REFERENCES actors(id),
      purpose TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'locked',
      listing_id TEXT,
      reason TEXT,
      locked_at TEXT NOT NULL,
      settled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      vin TEXT NOT NULL,
      deal_id TEXT NOT NULL REFERENCES deals(id),
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      price_amount TEXT NOT NULL,
      price_currency TEXT NOT NULL,
      evidence_root TEXT NOT NULL,
      escrow_tx_id TEXT,
      status TEXT NOT NULL,
      asset_id TEXT,
      metadata_uri TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reputation (
      actor_id TEXT PRIMARY KEY REFERENCES actors(id),
      role TEXT NOT NULL,
      deals_completed INTEGER NOT NULL DEFAULT 0,
      disputes_opened INTEGER NOT NULL DEFAULT 0,
      disputes_lost INTEGER NOT NULL DEFAULT 0,
      on_time_report_rate REAL,
      standard_compliance_rate REAL,
      median_report_hours REAL,
      listed_in_ranking INTEGER NOT NULL DEFAULT 1,
      last_computed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor_id TEXT,
      entity TEXT NOT NULL,
      entity_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

export type Row = Record<string, unknown>;

export function get(db: DatabaseSync, sql: string, params: unknown[] = []): Row | undefined {
  return db.prepare(sql).get(...(params as never[])) as Row | undefined;
}

export function all(db: DatabaseSync, sql: string, params: unknown[] = []): Row[] {
  return db.prepare(sql).all(...(params as never[])) as Row[];
}

export function run(db: DatabaseSync, sql: string, params: unknown[] = []): void {
  db.prepare(sql).run(...(params as never[]));
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
