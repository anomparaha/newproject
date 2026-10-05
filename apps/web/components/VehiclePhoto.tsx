'use client';

import { useState } from 'react';

/**
 * Vehicle photo with a deterministic mock fallback.
 *
 * Listings currently carry photo HASHES, not files: evidence upload is not
 * built yet, so there is no URL to render. Showing a placeholder image makes
 * the marketplace readable while that gap exists, and the badge on the image
 * says plainly that it is a placeholder. When real evidence exists, pass `src`
 * and the fallback disappears.
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
  alt,
  className = '',
  rounded = 'rounded-xl',
  badge = true,
}: {
  seed: string;
  src?: string;
  alt: string;
  className?: string;
  rounded?: string;
  badge?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const actual = !failed && src ? src : mockPhotoFor(seed);
  const isMock = !src || failed;

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
