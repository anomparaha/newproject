import type { DatabaseSync } from 'node:sqlite';
import type { MockEscrowProvider } from './escrow.js';
import { actorIdForToken } from './auth.js';

/**
 * Identity resolution.
 *
 * Two paths exist, and production must only have the first:
 *  1. `Authorization: Bearer <session token>` from a verified SIWS sign-in.
 *  2. The `x-actor-id` header, which is DEMO ONLY and is accepted only while
 *     VIN_DEMO_MODE is not 'false'. It exists so the Postman collection and the
 *     seed/smoke scripts can act as seeded actors without signing challenges.
 *
 * Set VIN_DEMO_MODE=false and path 2 disappears: every write then requires a
 * real, signature-backed session.
 */
export interface AppContext {
  db: DatabaseSync;
  escrow: MockEscrowProvider;
}

export function isDemoMode(): boolean {
  return process.env.VIN_DEMO_MODE !== 'false';
}

/** The legacy demo path. Returns null when demo mode is off. */
export function actorIdFromRequest(headerValue: string | undefined): string | null {
  if (!isDemoMode()) return null;
  return headerValue && headerValue.trim().length > 0 ? headerValue.trim() : null;
}

export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

/**
 * The single identity entry point used by every route.
 *
 * A verified session wins over the demo header: if a caller presents a valid
 * token, that is who they are, regardless of any header they also send.
 */
export function resolveActorId(c: { req: { header: (name: string) => string | undefined } }, ctx: AppContext): string | null {
  const token = bearerToken(c.req.header('authorization'));
  if (token) {
    const actorId = actorIdForToken(ctx.db, token);
    if (actorId) return actorId;
    // A presented-but-invalid token is not the same as no token: fail closed
    // rather than silently falling back to a demo header.
    return null;
  }
  return actorIdFromRequest(c.req.header('x-actor-id'));
}

/**
 * Simulated clock for DEMO DATA ONLY.
 *
 * Demo data seeded within seconds makes time-based metrics (e.g. median hours to
 * report) always read as 0 hours. The `x-demo-backdate-hours` header shifts
 * event timestamps so demo metrics make sense. It is IGNORED when
 * VIN_DEMO_MODE=false, and in production event time is always server time.
 */
export function demoBackdate(headerValue: string | undefined, now: () => string): string | null {
  if (process.env.VIN_DEMO_MODE === 'false') return null;
  if (!headerValue) return null;
  const hours = Number(headerValue);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 180) return null;
  return new Date(Date.parse(now()) - hours * 3_600_000).toISOString();
}
