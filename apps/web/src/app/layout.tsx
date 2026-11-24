import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { Figtree, Fraunces, Noto_Sans_Tamil } from "next/font/google";
import { isLocale } from "@localmeals/i18n";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { LocaleProvider } from "@/components/LocaleProvider";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { LOCALE_COOKIE } from "@/lib/locale";
import { siteUrl } from "@/lib/site";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  fallback: ["Georgia", "serif"],
});

const figtree = Figtree({
  subsets: ["latin"],
  variable: "--font-figtree",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

const notoTamil = Noto_Sans_Tamil({
  subsets: ["tamil"],
  weight: ["400", "700"],
  variable: "--font-tamil",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  adjustFontFallback: false,
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
