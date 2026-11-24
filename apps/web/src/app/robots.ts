import type { MetadataRoute } from "next";
import { NO_INDEX_PATHS, siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: NO_INDEX_PATHS }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
