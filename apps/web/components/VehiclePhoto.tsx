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
}: {
  seed: string;
  src?: string;
  alt: string;
  className?: string;
  rounded?: string;
}) {
  const [failed, setFailed] = useState(false);
  const actual = !failed && src ? src : mockPhotoFor(seed);
  const isMock = !src || failed;

  return (
    <div className={`relative overflow-hidden ${rounded} border border-ink-800 bg-ink-900 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={actual}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
      {isMock ? (
        <span className="absolute left-2 top-2 chip border-ink-600 bg-ink-950/70 text-mist-300">Photo placeholder</span>
      ) : null}
    </div>
  );
}
