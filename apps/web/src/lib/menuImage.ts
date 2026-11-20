/** Longest edge for customer plate heroes (≈2× retina card width). */
const MAX_LONG_EDGE = 1600;
/**
 * Reject tiny thumbs that look blurry when stretched.
 * Phone cameras / WhatsApp shares are usually well above this;
 * ~192px gallery thumbs are not.
 */
const MIN_LONG_EDGE = 480;
const MIN_SHORT_EDGE = 320;

const ALLOWED_PREFIX = "image/";
const BLOCKED_TYPES = new Set(["image/svg+xml", "image/tiff"]);

/**
 * Validate + lightly normalize a cook menu photo before upload.
 * Shared by breakfast / lunch / dinner (add plate + attach Photo).
 * - Rejects undersized images (cause blurry customer cards)
 * - Downscales very large shots to max 1600px long edge (JPEG 0.88)
 * - Converts HEIC/PNG/WebP to JPEG when the browser can decode them
 */
export async function prepareMenuPhoto(file: File): Promise<File> {
  const type = (file.type || "").toLowerCase();
  if (type && (!type.startsWith(ALLOWED_PREFIX) || BLOCKED_TYPES.has(type))) {
    throw new Error("Choose a JPEG, PNG, or WebP photo");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      "Could not read that photo — try JPEG or PNG (iPhone: set Camera → Formats → Most Compatible)",
    );
  }

  try {
    const { width, height } = bitmap;
    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    if (longEdge < MIN_LONG_EDGE || shortEdge < MIN_SHORT_EDGE) {
      throw new Error(
        "Photo is too small for the customer menu — use a clearer phone shot (about 500px or wider)",
      );
    }

    const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
    const alreadyJpeg =
      scale === 1 && (type === "image/jpeg" || type === "image/jpg");
    if (alreadyJpeg) {
      return file;
    }

    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.88),
    );
    if (!blob) return file;

    const base = file.name.replace(/\.[^.]+$/, "") || "plate";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}
