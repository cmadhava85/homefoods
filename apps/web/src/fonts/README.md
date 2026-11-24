# Self-hosted UI fonts (OFL)

WOFF2 subsets from [Fontsource](https://fontsource.org/) (Google Fonts OFL):

- Figtree / Fraunces — latin 400 + 700
- Noto Sans Tamil — tamil 400 + 700

Vendored so `next build` in Docker does not call fonts.googleapis.com (known flake: `Cannot read properties of null (reading '1')` in `next/font/google`).
