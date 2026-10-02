import type { NextConfig } from 'next';

/**
 * The frontend calls the backend through relative `/api/*` routes so it never
 * calls localhost from the browser. This rewrite forwards to the API service
  (in dev: http://127.0.0.1:8080; in production: the platform internal URL).
 */
const API_ORIGIN = process.env.VIN_API_URL ?? 'http://127.0.0.1:8080';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['*.e2b.app', '*.arena.ai', 'localhost', '127.0.0.1'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_NAME: 'VIN',
  },
};

export default nextConfig;
