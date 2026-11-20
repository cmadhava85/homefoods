import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  gcsUploadsBucket,
  saveConcernImage,
  saveMenuImage,
  saveMenuImageBuffer,
  saveUploadedImage,
  uploadsDir,
  usesGcsUploads,
} from "./uploads.js";
import { openUpload } from "./uploadsIo.js";

function jpegBuf(size = 16): Buffer {
  const jpeg = Buffer.alloc(size, 0);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[size - 1] = 0xd9;
  return jpeg;
}

function pngBuf(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
}

describe("uploads GCS toggle", () => {
  const prev = process.env.GCS_UPLOADS_BUCKET;

  afterEach(() => {
    if (prev === undefined) delete process.env.GCS_UPLOADS_BUCKET;
    else process.env.GCS_UPLOADS_BUCKET = prev;
  });

  it("uses local disk when GCS_UPLOADS_BUCKET unset", () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    assert.equal(usesGcsUploads(), false);
    assert.equal(gcsUploadsBucket(), null);
  });

  it("enables GCS when bucket name set", () => {
    process.env.GCS_UPLOADS_BUCKET = "my-uploads";
    assert.equal(usesGcsUploads(), true);
    assert.equal(gcsUploadsBucket(), "my-uploads");
  });

  it("trims bucket name and treats blank as unset", () => {
    process.env.GCS_UPLOADS_BUCKET = "  padded  ";
    assert.equal(gcsUploadsBucket(), "padded");
    process.env.GCS_UPLOADS_BUCKET = "   ";
    assert.equal(gcsUploadsBucket(), null);
    assert.equal(usesGcsUploads(), false);
  });
});

describe("saveUploadedImage local", () => {
  const prev = process.env.GCS_UPLOADS_BUCKET;

  afterEach(() => {
    if (prev === undefined) delete process.env.GCS_UPLOADS_BUCKET;
    else process.env.GCS_UPLOADS_BUCKET = prev;
  });

  it("rejects non-image mimetype", async () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    await assert.rejects(
      () =>
        saveUploadedImage({
          mimetype: "application/pdf",
          toBuffer: async () => Buffer.from("%PDF"),
        }),
      /Only JPEG, PNG, WebP, or GIF/,
    );
  });

  it("rejects mismatched magic bytes", async () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    await assert.rejects(
      () =>
        saveUploadedImage({
          mimetype: "image/jpeg",
          toBuffer: async () => Buffer.from("not-a-jpeg"),
        }),
      /not a valid image/,
    );
  });

  it("rejects mime/content mismatch", async () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    await assert.rejects(
      () =>
        saveUploadedImage({
          mimetype: "image/png",
          toBuffer: async () => jpegBuf(),
        }),
      /does not match/,
    );
  });

  it("rejects oversized images but allows exactly 5MB", async () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    await assert.rejects(
      () =>
        saveUploadedImage({
          mimetype: "image/jpeg",
          toBuffer: async () => jpegBuf(5 * 1024 * 1024 + 1),
        }),
      /under 5MB/,
    );
    const ok = await saveUploadedImage({
      mimetype: "image/jpeg",
      toBuffer: async () => jpegBuf(5 * 1024 * 1024),
    });
    assert.match(ok, /^\/uploads\/img-/);
  });

  it("saves jpeg to disk and returns /uploads path", async () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    const jpeg = jpegBuf();
    const url = await saveUploadedImage(
      {
        mimetype: "image/jpeg",
        toBuffer: async () => jpeg,
      },
      "menu",
    );
    assert.match(url, /^\/uploads\/menu-[a-f0-9-]+\.jpg$/);
    const name = url.replace("/uploads/", "");
    assert.ok(fs.existsSync(path.join(uploadsDir(), name)));
  });

  it("defaults prefix to img and accepts gif/webp", async () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    const gif = Buffer.alloc(16, 0);
    gif.write("GIF89a", 0, "ascii");
    const gifUrl = await saveUploadedImage({
      mimetype: "image/gif",
      toBuffer: async () => gif,
    });
    assert.match(gifUrl, /^\/uploads\/img-[a-f0-9-]+\.gif$/);

    const gif87 = Buffer.alloc(16, 0);
    gif87.write("GIF87a", 0, "ascii");
    const gif87Url = await saveUploadedImage({
      mimetype: "image/gif",
      toBuffer: async () => gif87,
    });
    assert.match(gif87Url, /\.gif$/);

    const webp = Buffer.alloc(16, 0);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    const webpUrl = await saveUploadedImage({
      mimetype: "image/webp",
      toBuffer: async () => webp,
    });
    assert.match(webpUrl, /^\/uploads\/img-[a-f0-9-]+\.webp$/);
  });

  it("saves png via saveMenuImage / saveConcernImage prefixes", async () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    const menu = await saveMenuImage({
      mimetype: "image/png",
      toBuffer: async () => pngBuf(),
    });
    assert.match(menu, /^\/uploads\/menu-[a-f0-9-]+\.png$/);
    const concern = await saveConcernImage({
      mimetype: "image/png",
      toBuffer: async () => pngBuf(),
    });
    assert.match(concern, /^\/uploads\/concern-[a-f0-9-]+\.png$/);
  });

  it("saveMenuImageBuffer writes jpeg under menu- prefix", async () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    const url = await saveMenuImageBuffer(jpegBuf(), "image/jpeg");
    assert.match(url, /^\/uploads\/menu-[a-f0-9-]+\.jpg$/);
    const name = url.replace("/uploads/", "");
    assert.ok(fs.existsSync(path.join(uploadsDir(), name)));
    const defaultMime = await saveMenuImageBuffer(jpegBuf());
    assert.match(defaultMime, /^\/uploads\/menu-[a-f0-9-]+\.jpg$/);
  });

  it("openUpload reads local file and rejects bad names", async () => {
    delete process.env.GCS_UPLOADS_BUCKET;
    const url = await saveUploadedImage(
      { mimetype: "image/jpeg", toBuffer: async () => jpegBuf() },
      "img",
    );
    const name = url.replace("/uploads/", "");
    const opened = await openUpload(name);
    assert.ok(opened);
    assert.equal(opened!.contentType, "image/jpeg");
    assert.equal(await openUpload("menu-missing.jpg"), null);
    await assert.rejects(() => openUpload("../secret.jpg"), /Invalid upload name/);
  });
});
