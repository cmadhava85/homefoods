import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LocalMeals",
    short_name: "LocalMeals",
    description: "Home-cooked lunch from kitchens near you",
    start_url: "/",
    display: "standalone",
    background_color: "#e4ece7",
    theme_color: "#0d5840",
    lang: "en-IN",
  };
}
