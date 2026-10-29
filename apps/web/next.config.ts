import type { NextConfig } from 'next';

/**
 * The console is a thin projection of `apps/api`: no DB access, no harness calls, no
 * filesystem reads from the browser. Server components fetch the API; client components
 * talk to same-origin route handlers under `/api/*` which proxy the API (this also avoids
 * CORS and keeps SSE un-buffered).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Keep the client bundle small; these are server-only workspace packages.
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default nextConfig;
