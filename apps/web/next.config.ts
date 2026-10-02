import type { NextConfig } from 'next';

/**
 * Frontend memanggil backend lewat rute relatif `/api/*` supaya tidak pernah
 * memanggil localhost dari browser. Rewrite ini diteruskan ke service API
 * (di dev: http://127.0.0.1:8080; di produksi: URL internal platform).
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
