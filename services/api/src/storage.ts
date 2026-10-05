/**
 * Evidence object storage.
 *
 * The one rule that matters: evidence is stored CONTENT-ADDRESSED. The sha256 of
 * the bytes IS the object id, so
 *  - the hash is computed by the server on upload (the client cannot lie about
 *    it), and it is the only thing meant to travel to the event log / chain;
 *  - identical bytes never duplicate; and
 *  - any later tampering changes the hash, so a stored object can always be
 *    re-verified against the id it was fetched by.
 *
 * Two implementations behind one interface, mirroring the escrow split:
 *  - `LocalObjectStore` writes to the filesystem (MVP / dev / single node).
 *  - `MemoryObjectStore` keeps bytes in a Map (tests, ephemeral).
 * A future `S3ObjectStore` / `R2ObjectStore` implements the same surface, so the
 * route code never changes when storage moves to a real bucket.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './db.js';

export interface StoredObject {
  hash: string;
  size: number;
  contentType: string;
}

export interface ObjectStore {
  readonly kind: string;
  /** Store bytes and return the content-addressed descriptor. Idempotent. */
  put(bytes: Uint8Array, contentType: string): StoredObject;
  /** Fetch stored bytes + content type by hash, or null if absent. */
  get(hash: string): { bytes: Uint8Array; contentType: string } | null;
  has(hash: string): boolean;
  /** The browser-reachable path this object is served from. */
  url(hash: string): string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const HASH_SHAPE = /^[0-9a-f]{64}$/;

/** A valid evidence id is exactly a lowercase hex sha256 (also blocks path traversal). */
export function isEvidenceHash(hash: string): boolean {
  return HASH_SHAPE.test(hash);
}

export class MemoryObjectStore implements ObjectStore {
  readonly kind = 'memory';
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  put(bytes: Uint8Array, contentType: string): StoredObject {
    const hash = sha256Hex(bytes);
    if (!this.objects.has(hash)) this.objects.set(hash, { bytes, contentType });
    return { hash, size: bytes.byteLength, contentType };
  }

  get(hash: string): { bytes: Uint8Array; contentType: string } | null {
    return this.objects.get(hash) ?? null;
  }

  has(hash: string): boolean {
    return this.objects.has(hash);
  }

  url(hash: string): string {
    return `/api/evidence/${hash}`;
  }
}

export class LocalObjectStore implements ObjectStore {
  readonly kind = 'local';
  private readonly baseDir: string;

  constructor(baseDir: string = process.env.VIN_EVIDENCE_DIR ?? resolve(REPO_ROOT, '.data/evidence')) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private file(hash: string): string {
    return resolve(this.baseDir, hash);
  }

  put(bytes: Uint8Array, contentType: string): StoredObject {
    const hash = sha256Hex(bytes);
    const path = this.file(hash);
    if (!existsSync(path)) {
      writeFileSync(path, bytes);
      writeFileSync(`${path}.type`, contentType, 'utf8');
    }
    return { hash, size: bytes.byteLength, contentType };
  }

  get(hash: string): { bytes: Uint8Array; contentType: string } | null {
    if (!isEvidenceHash(hash)) return null;
    const path = this.file(hash);
    if (!existsSync(path)) return null;
    const bytes = new Uint8Array(readFileSync(path));
    const typePath = `${path}.type`;
    const contentType = existsSync(typePath) ? readFileSync(typePath, 'utf8') : 'application/octet-stream';
    return { bytes, contentType };
  }

  has(hash: string): boolean {
    return isEvidenceHash(hash) && existsSync(this.file(hash));
  }

  url(hash: string): string {
    return `/api/evidence/${hash}`;
  }
}
