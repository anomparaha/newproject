'use client';

import { useState } from 'react';

/**
 * Vehicle photo with a deterministic mock fallback.
 *
 * Evidence is content-addressed: pass a `hash` and the image is loaded from
 * `GET /api/evidence/:hash`, or pass an explicit `src`. When neither resolves
 * (or the fetch fails), a deterministic placeholder keeps the marketplace
 * readable and the badge says plainly that it is a placeholder. Demo listings
 * still carry hashes with no uploaded bytes, so they fall back gracefully.
 */

const MOCK_PHOTOS: [string, ...string[]] = ['/mock/vehicle-1.jpg', '/mock/vehicle-2.jpg', '/mock/vehicle-3.jpg'];

/** Stable per listing so a card does not change picture on every render. */
export function mockPhotoFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
  return MOCK_PHOTOS[hash % MOCK_PHOTOS.length] ?? MOCK_PHOTOS[0];
}

export function VehiclePhoto({
  seed,
  src,
  hash,
  alt,
  className = '',
  rounded = 'rounded-xl',
  badge = true,
}: {
  seed: string;
  src?: string;
  hash?: string;
  alt: string;
  className?: string;
  rounded?: string;
  badge?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const resolved = src ?? (hash ? `/api/evidence/${hash}` : undefined);
  const actual = !failed && resolved ? resolved : mockPhotoFor(seed);
  const isMock = !resolved || failed;

  return (
    <div className={`relative overflow-hidden bg-subtle ${rounded} ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={actual}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
      />
      {isMock && badge ? (
        <span className="absolute bottom-2.5 left-2.5 rounded-full bg-white/90 px-2 py-0.5 text-[0.65rem] font-medium text-muted shadow-card backdrop-blur">
          Photo placeholder
        </span>
      ) : null}
    </div>
  );
}
