import type { FastifyInstance } from "fastify";
import { publicMenuObjectUrl, usesGcsUploads } from "../uploads.js";
import { openUpload, publicMenuObjectExists } from "../uploadsIo.js";
import { UploadNameParams } from "./uploadsRoutes.contract.js";

/**
 * When GCS is enabled, serve GET /uploads/:name from the bucket.
 * Menu photos that live in the public bucket are redirected there (the web links to it directly;
 * this only catches older stored URLs). Local disk mode keeps using @fastify/static from buildApp.
 */
export async function uploadsRoutes(app: FastifyInstance) {
  if (!usesGcsUploads()) return;

  app.get("/uploads/:name", async (req, reply) => {
    const parsed = UploadNameParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid upload name" });
    const { name } = parsed.data;
    try {
      const publicUrl = publicMenuObjectUrl(name);
      if (publicUrl && (await publicMenuObjectExists(name))) {
        reply.header("Cache-Control", "public, max-age=86400");
        return reply.redirect(publicUrl, 301);
      }
      const opened = await openUpload(name);
      if (!opened) return reply.code(404).send({ error: "Not found" });
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", "public, max-age=86400");
      reply.header("Content-Disposition", "inline");
      return reply.type(opened.contentType).send(opened.stream);
    } catch {
      return reply.code(400).send({ error: "Invalid upload name" });
    }
  });
}
