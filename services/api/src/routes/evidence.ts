import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { resolveActorId, type AppContext } from '../context.js';
import { isEvidenceHash } from '../storage.js';

/** Cap on a single evidence upload, measured on the decoded bytes. */
const MAX_EVIDENCE_BYTES = Number(process.env.VIN_EVIDENCE_MAX_BYTES ?? 10 * 1024 * 1024);

/** Evidence is photos, dashboards, and inspection PDFs — nothing executable. */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

const zUpload = z.object({
  contentType: z.string().min(3).max(100),
  dataBase64: z.string().min(1),
  // A human label kept only in the response; it is NOT part of the hash.
  filename: z.string().max(200).optional(),
});

export function evidenceRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  /**
   * Upload one evidence file. The server decodes the bytes, computes their
   * sha256, and stores them content-addressed. The response hands back the hash
   * so the caller can attach it to a listing / report / note. Only the hash is
   * meant to leave this service; the bytes stay in object storage.
   */
  app.post('/evidence', zValidator('json', zUpload), (c) => {
    const actorId = resolveActorId(c, ctx);
    if (!actorId) {
      return c.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Uploading evidence requires an identified caller' } },
        401,
      );
    }

    const { contentType, dataBase64, filename } = c.req.valid('json');
    if (!ALLOWED_TYPES.has(contentType)) {
      return c.json(
        { error: { code: 'UNSUPPORTED_TYPE', message: `contentType must be one of: ${[...ALLOWED_TYPES].join(', ')}` } },
        415,
      );
    }

    const bytes = new Uint8Array(Buffer.from(dataBase64, 'base64'));
    if (bytes.byteLength === 0) {
      return c.json({ error: { code: 'BAD_PAYLOAD', message: 'dataBase64 decoded to zero bytes' } }, 400);
    }
    if (bytes.byteLength > MAX_EVIDENCE_BYTES) {
      return c.json({ error: { code: 'TOO_LARGE', message: `evidence exceeds the ${MAX_EVIDENCE_BYTES}-byte limit` } }, 413);
    }

    const stored = ctx.store.put(bytes, contentType);
    return c.json(
      {
        hash: stored.hash,
        size: stored.size,
        contentType: stored.contentType,
        url: ctx.store.url(stored.hash),
        filename: filename ?? null,
        storage: ctx.store.kind,
        note: 'Record only this hash on the event log / chain. The bytes stay off-chain.',
      },
      201,
    );
  });

  /**
   * Serve stored evidence by hash. Content-addressed, so the body never changes
   * for a given hash and can be cached hard — but PRIVATELY. Evidence is vehicle
   * photos and inspection PDFs that can contain personal data (plates, documents),
   * so `private` keeps it out of shared/CDN caches while still letting the one
   * browser that fetched it cache the bytes. A bad hash is a 400, a miss is a 404.
   */
  app.get('/evidence/:hash', (c) => {
    const hash = c.req.param('hash');
    if (!isEvidenceHash(hash)) {
      return c.json({ error: { code: 'BAD_HASH', message: 'hash must be 64 lowercase hex chars (sha256)' } }, 400);
    }
    const object = ctx.store.get(hash);
    if (!object) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'No evidence stored for this hash' } }, 404);
    }
    return new Response(object.bytes, {
      status: 200,
      headers: {
        'Content-Type': object.contentType,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  return app;
}
