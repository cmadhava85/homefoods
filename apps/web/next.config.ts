import type { NextConfig } from "next";
import path from "node:path";
import { legalDetailsMissing } from "./src/lib/legal";

const apiUpstream =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://127.0.0.1:4000";

if (process.env.LEGAL_STRICT === "true") {
  const missing = legalDetailsMissing();
  if (missing.length) {
    throw new Error(
      `LEGAL_STRICT=true but legal details missing: ${missing.join(", ")}. ` +
        "Set NEXT_PUBLIC_LEGAL_* / NEXT_PUBLIC_SUPPORT_* / NEXT_PUBLIC_GRIEVANCE_* build args.",
    );
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle (only traced files) for a small Cloud Run image.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
  transpilePackages: ["@localmeals/i18n", "@localmeals/domain"],
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
