import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Soft gate: require `lm_session` cookie for desk/account surfaces. API still enforces auth. */
const PROTECTED = [
  /^\/admin(?:\/|$)/,
  /^\/cook(?:\/|$)/,
  /^\/orders(?:\/|$)/,
  /^\/account(?:\/|$)/,
  /^\/family(?:\/|$)/,
];

/** Public cook enrollment — not a desk route. */
const PUBLIC_COOK = [/^\/cook\/onboard(?:\/|$)/];

function buildCsp(nonce: string) {
  // Next.js Fast Refresh needs 'unsafe-eval' in development only.
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    process.env.NODE_ENV === "production" ? null : "'unsafe-eval'",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // HMR websocket in next dev
    process.env.NODE_ENV === "production"
      ? "connect-src 'self'"
      : "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

function withSecurityHeaders(res: NextResponse, nonce: string) {
  res.headers.set("Content-Security-Policy", buildCsp(nonce));
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return res;
}

export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  const { pathname } = req.nextUrl;
  const needsAuth =
    PROTECTED.some((re) => re.test(pathname)) &&
    !PUBLIC_COOK.some((re) => re.test(pathname)) &&
    !req.cookies.get("lm_session")?.value;
  if (needsAuth) {
    const role = pathname.startsWith("/admin")
      ? "admin"
      : pathname.startsWith("/cook")
        ? "cook"
        : "customer";
    const login = new URL("/login", req.url);
    login.searchParams.set("role", role);
    login.searchParams.set("next", pathname);
    return withSecurityHeaders(NextResponse.redirect(login), nonce);
  }

  return withSecurityHeaders(
    NextResponse.next({
      request: { headers: requestHeaders },
    }),
    nonce,
  );
}

export const config = {
  matcher: [
    /*
     * Apply CSP + soft auth gate to app routes; skip static assets.
     */
    "/((?!_next/static|_next/image|favicon.ico|uploads/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
