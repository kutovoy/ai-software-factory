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
  // The local forge is served at `/extras/forgejo/` (its ROOT_URL ends with a slash), and
  // Next would otherwise 308 the trailing-slash home page before routing. Middleware
  // (src/middleware.ts) rewrites it for the forge prefix only; the console's own routes
  // keep working because they are never linked with a trailing slash.
  skipTrailingSlashRedirect: true,
  experimental: {
    // Keep the client bundle small; these are server-only workspace packages.
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default nextConfig;
