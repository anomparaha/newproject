import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  AuthError,
  actorIdForToken,
  createChallenge,
  createWalletActor,
  findActorByWallet,
  isValidSolanaAddress,
  issueSession,
  revokeSession,
  sessionRowForToken,
  verifyChallenge,
} from '../auth.js';
import { bearerToken, isDemoMode, resolveActorId, type AppContext } from '../context.js';
import { get } from '../db.js';
import { serializeActor } from '../serialize.js';

const zAddress = z.string().min(32).max(44).refine(isValidSolanaAddress, 'not a valid Solana address');

const zChallengeBody = z.object({ walletAddress: zAddress });

const zVerifyBody = z.object({
  walletAddress: zAddress,
  nonce: z.string().min(8).max(128),
  signature: z.string().min(32).max(200),
  role: z.enum(['buyer', 'seller', 'inspector', 'curator', 'arbiter']).optional(),
  displayName: z.string().min(2).max(120).optional(),
  email: z.string().email().optional(),
  countryCode: z.string().length(2).optional(),
  city: z.string().max(80).optional(),
});

/** Where the sign-in message is anchored. Set VIN_AUTH_DOMAIN in production. */
function authAnchor(c: { req: { header: (name: string) => string | undefined } }) {
  const host = c.req.header('host') ?? 'localhost:8080';
  const proto = c.req.header('x-forwarded-proto') ?? 'http';
  return {
    domain: process.env.VIN_AUTH_DOMAIN ?? host,
    uri: process.env.VIN_AUTH_URI ?? `${proto}://${host}`,
    chainId: process.env.VIN_SOLANA_CHAIN_ID ?? 'solana:localnet',
  };
}

export function authRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  /** Step 1: ask for a nonce and the exact message to sign. */
  app.post('/auth/challenge', zValidator('json', zChallengeBody), (c) => {
    const { walletAddress } = c.req.valid('json');
    const challenge = createChallenge(ctx.db, { walletAddress, ...authAnchor(c) });
    const existing = findActorByWallet(ctx.db, walletAddress);
    return c.json({
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
      // The client uses this to decide whether it is signing in or signing up.
      knownWallet: Boolean(existing),
      chainId: authAnchor(c).chainId,
    });
  });

  /** Step 2: hand back the signature. Only a valid one creates a session. */
  app.post('/auth/verify', zValidator('json', zVerifyBody), (c) => {
    const input = c.req.valid('json');

    // Profile requirements are checked BEFORE the signature is verified, so a
    // missing display name does not burn the challenge. The client can resubmit
    // the same signature once it has collected the profile: one wallet prompt,
    // not two.
    const existingActor = findActorByWallet(ctx.db, input.walletAddress);
    let newProfile: { role: 'buyer' | 'seller' | 'inspector' | 'curator' | 'arbiter'; displayName: string; email: string; countryCode: string } | null = null;
    if (!existingActor) {
      const role = input.role ?? 'buyer';
      if (!input.displayName) {
        return c.json(
          {
            error: {
              code: 'PROFILE_REQUIRED',
              message: 'This wallet has no account yet; displayName is required to create one',
            },
          },
          400,
        );
      }
      if (role !== 'buyer' && (!input.countryCode || !input.email)) {
        return c.json(
          {
            error: {
              code: 'PROFILE_REQUIRED',
              message: 'Seller, workshop and curator accounts need countryCode and email before they can operate',
            },
          },
          400,
        );
      }
      newProfile = {
        role,
        displayName: input.displayName,
        // Wallet-first accounts may have no email; social login (not built) would supply one.
        email: input.email ?? '',
        countryCode: input.countryCode ?? 'AE',
      };
    }

    let verified;
    try {
      verified = verifyChallenge(ctx.db, {
        walletAddress: input.walletAddress,
        nonce: input.nonce,
        signature: input.signature,
      });
    } catch (error) {
      if (error instanceof AuthError) {
        return c.json({ error: { code: error.code, message: error.message } }, error.status);
      }
      throw error;
    }

    let actor = existingActor;
    let created = false;

    if (!actor && newProfile) {
      actor = createWalletActor(ctx.db, {
        walletAddress: verified.walletAddress,
        role: newProfile.role,
        displayName: newProfile.displayName,
        email: newProfile.email,
        countryCode: newProfile.countryCode,
        city: input.city,
      });
      created = true;
    }
    if (!actor) return c.json({ error: { code: 'INTERNAL', message: 'Could not resolve an actor for this wallet' } }, 500);

    const session = issueSession(ctx.db, {
      actorId: String(actor.id),
      method: 'wallet',
      walletAddress: verified.walletAddress,
    });

    return c.json(
      {
        token: session.token,
        expiresAt: session.expiresAt,
        created,
        actor: serializeActor(actor),
        note: 'Keep this token out of URLs and logs. It authenticates every write as this actor.',
      },
      created ? 201 : 200,
    );
  });

  /** Who am I? Used by the frontend to drop a stale token. */
  app.get('/auth/session', (c) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'No bearer token presented' } }, 401);
    const actorId = actorIdForToken(ctx.db, token);
    const row = sessionRowForToken(ctx.db, token);
    if (!actorId || !row) {
      return c.json({ error: { code: 'UNAUTHENTICATED', message: 'This session is unknown, revoked, or expired' } }, 401);
    }
    const actor = get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [actorId]);
    if (!actor) return c.json({ error: { code: 'NOT_FOUND', message: 'Actor for this session is gone' } }, 404);
    return c.json({
      actor: serializeActor(actor),
      method: String(row.method),
      walletAddress: row.wallet_address === null ? null : String(row.wallet_address),
      expiresAt: String(row.expires_at),
    });
  });

  app.post('/auth/signout', (c) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'No bearer token presented' } }, 401);
    const revoked = revokeSession(ctx.db, token);
    return c.json({ revoked });
  });

  /** What identity paths this deployment accepts. Honest by construction. */
  app.get('/auth/methods', (c) =>
    c.json({
      demoMode: isDemoMode(),
      methods: [
        {
          id: 'wallet',
          label: 'Connect wallet (SIWS)',
          implemented: true,
          note: 'Ed25519 signature over a single-use nonce; creates a session token.',
        },
        {
          id: 'google',
          label: 'Continue with Google',
          implemented: false,
          note: 'UI only. Social sign-in needs OAuth credentials AND an embedded-wallet provider so the user still ends up with an address.',
        },
        {
          id: 'x',
          label: 'Continue with X',
          implemented: false,
          note: 'Same as Google: credentials plus embedded wallet; not built.',
        },
      ],
      wallets: ['Phantom', 'Solflare', 'Backpack'],
      demoHeaderAccepted: isDemoMode(),
    }),
  );

  return app;
}

export { resolveActorId };
