import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Persist menu/concern photos under apps/api/uploads or GCS (served at /uploads). */
export function uploadsDir() {
  const dir = process.env.UPLOADS_DIR ?? path.join(__dirname, "..", "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** When set, new uploads go to this bucket; GET /uploads/* is proxied from GCS. */
export function gcsUploadsBucket(): string | null {
  const b = process.env.GCS_UPLOADS_BUCKET?.trim();
  return b || null;
}

/** Public-read bucket for menu photos only (served directly by GCS, not the API). */
export function gcsPublicMenuBucket(): string | null {
  const b = process.env.GCS_PUBLIC_MENU_BUCKET?.trim();
  return b || null;
}

export function publicMenuObjectUrl(name: string): string | null {
  const bucket = gcsPublicMenuBucket();
  return bucket && name.startsWith("menu-") ? `https://storage.googleapis.com/${bucket}/${name}` : null;
}

export function usesGcsUploads(): boolean {
  return Boolean(gcsUploadsBucket());
}

type ImageKind = "jpeg" | "png" | "webp" | "gif";

function detectImageKind(buf: Buffer): ImageKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "png";
  }
  if (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a") {
    return "gif";
  }
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  return null;
}

const MIME_TO_KIND: Record<string, ImageKind> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const KIND_MIME: Record<ImageKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export async function saveUploadedImage(
  file: {
    mimetype: string;
    filename?: string;
    toBuffer: () => Promise<Buffer>;
  },
  prefix = "img",
) {
  const claimed = MIME_TO_KIND[file.mimetype];
  if (!claimed) {
    throw new Error("Only JPEG, PNG, WebP, or GIF images are allowed");
  }
  const buf = await file.toBuffer();
  if (buf.byteLength > 5 * 1024 * 1024) {
    throw new Error("Image must be under 5MB");
  }
  const kind = detectImageKind(buf);
  if (!kind) {
    throw new Error("File content is not a valid image");
  }
  if (kind !== claimed) {
    throw new Error("Image type does not match file contents");
  }
  const ext = kind === "jpeg" ? "jpg" : kind;
  const name = `${prefix}-${randomUUID()}.${ext}`;
  const contentType = KIND_MIME[kind];

  // GCS path needs cloud credentials — covered via env toggle unit tests + staging smoke.
  // Stryker disable next-line all
  if (usesGcsUploads()) {
    const { writeGcsObject } = await import("./uploadsIo.js");
    await writeGcsObject(name, buf, contentType);
  } else {
    const dest = path.join(uploadsDir(), name);
    fs.writeFileSync(dest, buf);
  }
  // Stable public path — API proxies from GCS or serves from disk.
  return `/uploads/${name}`;
}

export async function saveMenuImage(file: {
  mimetype: string;
  filename?: string;
  toBuffer: () => Promise<Buffer>;
}) {
  return saveUploadedImage(file, "menu");
}

/** Save menu image from an in-memory buffer (WhatsApp media / mock base64). */
export async function saveMenuImageBuffer(buffer: Buffer, mimeType = "image/jpeg") {
  return saveUploadedImage(
    {
      mimetype: mimeType,
      filename: "wa-menu",
      toBuffer: async () => buffer,
    },
    "menu",
  );
}

export async function saveConcernImage(file: {
  mimetype: string;
  filename?: string;
  toBuffer: () => Promise<Buffer>;
}) {
  return saveUploadedImage(file, "concern");
}

export { openUpload } from "./uploadsIo.js";
