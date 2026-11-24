import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { gcsPublicMenuBucket, gcsUploadsBucket, uploadsDir } from "./uploads.js";

type ImageKind = "jpeg" | "png" | "webp" | "gif";

const KIND_MIME: Record<ImageKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function sanitizeUploadName(name: string): string {
  const base = path.basename(name);
  if (!/^(menu|concern|img)-[a-zA-Z0-9._-]+$/.test(base)) {
    throw new Error("Invalid upload name");
  }
  return base;
}

async function gcsClient() {
  const { Storage } = await import("@google-cloud/storage");
  return new Storage();
}

export async function writeGcsObject(name: string, buf: Buffer, contentType: string) {
  // Menu photos are public and immutable (random names) → public bucket + long edge cache.
  const publicMenu = name.startsWith("menu-") ? gcsPublicMenuBucket() : null;
  const bucketName = publicMenu ?? gcsUploadsBucket();
  if (!bucketName) throw new Error("GCS_UPLOADS_BUCKET not set");
  const storage = await gcsClient();
  const file = storage.bucket(bucketName).file(name);
  await file.save(buf, {
    contentType,
    resumable: false,
    metadata: {
      cacheControl: publicMenu ? "public, max-age=31536000, immutable" : "private, max-age=86400",
    },
  });
}

/** True when a menu photo already lives in the public bucket (new uploads, or copied legacy ones). */
export async function publicMenuObjectExists(name: string): Promise<boolean> {
  const bucket = gcsPublicMenuBucket();
  if (!bucket || !name.startsWith("menu-")) return false;
  const storage = await gcsClient();
  const [exists] = await storage.bucket(bucket).file(sanitizeUploadName(name)).exists();
  return exists;
}

export async function openUpload(
  name: string,
): Promise<{ stream: Readable; contentType: string } | null> {
  const safe = sanitizeUploadName(name);
  const ext = path.extname(safe).slice(1).toLowerCase();
  const kind: ImageKind | null =
    ext === "jpg" || ext === "jpeg"
      ? "jpeg"
      : ext === "png"
        ? "png"
        : ext === "webp"
          ? "webp"
          : ext === "gif"
            ? "gif"
            : null;
  const contentType = kind ? KIND_MIME[kind] : "application/octet-stream";

  const bucketName = gcsUploadsBucket();
  if (bucketName) {
    const storage = await gcsClient();
    const file = storage.bucket(bucketName).file(safe);
    const [exists] = await file.exists();
    if (!exists) return null;
    return { stream: file.createReadStream(), contentType };
  }

  const dest = path.join(uploadsDir(), safe);
  if (!fs.existsSync(dest)) return null;
  return { stream: fs.createReadStream(dest), contentType };
}
