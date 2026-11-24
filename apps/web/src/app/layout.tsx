import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import localFont from "next/font/local";
import { isLocale } from "@localmeals/i18n";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { LocaleProvider } from "@/components/LocaleProvider";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { LOCALE_COOKIE } from "@/lib/locale";
import { siteUrl } from "@/lib/site";

/** Self-hosted (OFL) — avoids next/font/google CDN flakes in Docker/CI builds. */
const fraunces = localFont({
  src: [
    { path: "../fonts/fraunces-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/fraunces-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-fraunces",
  display: "swap",
  fallback: ["Georgia", "serif"],
});

const figtree = localFont({
  src: [
    { path: "../fonts/figtree-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/figtree-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-figtree",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

const notoTamil = localFont({
  src: [
    { path: "../fonts/noto-sans-tamil-tamil-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/noto-sans-tamil-tamil-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-tamil",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  adjustFontFallback: false,
  preload: false,
});

const description = "Home-cooked lunch from kitchens near you";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: "LocalMeals", template: "%s · LocalMeals" },
  description,
  applicationName: "LocalMeals",
  openGraph: {
    type: "website",
    siteName: "LocalMeals",
    title: "LocalMeals",
    description,
    locale: "en_IN",
  },
  twitter: { card: "summary", title: "LocalMeals", description },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#0d5840",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read nonce so this layout is request-dynamic; Next attaches it to its scripts via CSP.
  await headers();
  const jar = await cookies();
  const cookieLocale = jar.get(LOCALE_COOKIE)?.value;
  const lang = isLocale(cookieLocale) ? cookieLocale : "en";

  return (
    <html
      lang={lang}
      className={`${fraunces.variable} ${figtree.variable} ${notoTamil.variable}`}
    >
      <body>
        <AuthProvider>
          <LocaleProvider>
            <div className="shell">
              <SiteHeader />
              <div className="shell-main">{children}</div>
              <SiteFooter />
            </div>
          </LocaleProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
