/**
 * In-memory sliding-window rate limiter.
 *
 * Scope note: this limiter lives inside the API process. One Node instance is
 * enough for the pilot corridor, so a Map keyed by caller is both simplest and
 * has zero external dependencies. Horizontal scaling later needs a shared store
 * (e.g. Redis); the `RateLimiter` surface here stays the same so only the
 * backing store changes, not the call sites.
 *
 * Why it exists: SIWS has two endpoints that must not be hammered.
 *  - `/auth/challenge` mints a nonce row per call; without a limit a caller can
 *    flood the table.
 *  - `/auth/verify` is where a captured message would be brute-forced; a limit
 *    turns "unlimited guesses" into "a handful per minute".
 */

export interface RateLimitRule {
  /** Length of the rolling window, in milliseconds. */
  windowMs: number;
  /** How many hits are allowed inside the window before requests are refused. */
  max: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds the caller should wait before the oldest hit leaves the window. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record a hit for `key` and report whether it is allowed. A refused hit is
   * NOT recorded, so a blocked caller cannot push its own window forward.
   */
  check(key: string): RateLimitResult {
    const now = this.now();
    const windowStart = now - this.rule.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);

    if (recent.length >= this.rule.max) {
      this.hits.set(key, recent);
      const retryAfterMs = recent[0]! + this.rule.windowMs - now;
      return { ok: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true, remaining: this.rule.max - recent.length, retryAfterSeconds: 0 };
  }

  /** Drop all counters. Used by tests and by scheduled cleanup. */
  reset(): void {
    this.hits.clear();
  }
}

/**
 * Best-effort client IP from the usual proxy headers. Falls back to `local` when
 * nothing is present (direct calls, in-process tests), so a key is always well
 * defined. Combined with the wallet address at the call site, a single bad actor
 * on one IP cannot exhaust the budget of a different wallet.
 */
export function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff && xff.trim().length > 0) return xff.split(',')[0]!.trim();
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? 'local';
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Defaults are generous enough for a human signing in a few times, but low
 * enough to stop a flood. Overridable by env so the Postman/demo runs and
 * production can tune without a code change.
 */
export function challengeRateRule(): RateLimitRule {
  return {
    windowMs: intFromEnv('VIN_AUTH_RATE_WINDOW_MS', 60_000),
    max: intFromEnv('VIN_AUTH_CHALLENGE_MAX', 30),
  };
}

export function verifyRateRule(): RateLimitRule {
  return {
    windowMs: intFromEnv('VIN_AUTH_RATE_WINDOW_MS', 60_000),
    max: intFromEnv('VIN_AUTH_VERIFY_MAX', 15),
  };
}
