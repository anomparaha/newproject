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

/** Name of the httpOnly cookie that carries the session token for browsers. */
export const SESSION_COOKIE = 'vin_session';

/** Read a single cookie value out of a raw Cookie header, without a dependency. */
export function cookieToken(cookieHeader: string | undefined, name = SESSION_COOKIE): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * The session token for a request, from either transport:
 *  - `Authorization: Bearer <token>` (API clients, Postman), or
 *  - the `vin_session` httpOnly cookie (browsers, so the token never has to live
 *    in JavaScript-reachable storage).
 * The header wins when both are present.
 */
export function sessionToken(c: { req: { header: (name: string) => string | undefined } }): string | null {
  return bearerToken(c.req.header('authorization')) ?? cookieToken(c.req.header('cookie'));
}

/**
 * The single identity entry point used by every route.
 *
 * A verified session wins over the demo header: if a caller presents a valid
 * token, that is who they are, regardless of any header they also send.
 */
export function resolveActorId(c: { req: { header: (name: string) => string | undefined } }, ctx: AppContext): string | null {
  const token = sessionToken(c);
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
