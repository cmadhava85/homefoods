import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Figtree, Fraunces, Noto_Sans_Tamil } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { LocaleProvider } from "@/components/LocaleProvider";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});

const figtree = Figtree({
  subsets: ["latin"],
  variable: "--font-figtree",
  display: "swap",
});

const notoTamil = Noto_Sans_Tamil({
  subsets: ["tamil"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-tamil",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LocalMeals",
  description: "Home-cooked lunch from kitchens near you",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read nonce so this layout is request-dynamic; Next attaches it to its scripts via CSP.
  await headers();

  return (
    <html
      lang="en"
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
