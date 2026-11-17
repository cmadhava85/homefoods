import type { NextConfig } from "next";

const apiUpstream =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@localmeals/i18n"],
  async rewrites() {
    const api = apiUpstream.replace(/\/$/, "");
    return [
      {
        source: "/lm-api/:path*",
        destination: `${api}/:path*`,
      },
      {
        source: "/uploads/:path*",
        destination: `${api}/uploads/:path*`,
      },
    ];
  },
  // CSP + frame/nosniff are set per-request in middleware (nonce-based script-src).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
