import type { FastifyInstance } from "fastify";
import { usesGcsUploads } from "../uploads.js";
import { openUpload } from "../uploadsIo.js";

/**
 * When GCS is enabled, proxy GET /uploads/:name from the bucket.
 * Local disk mode keeps using @fastify/static from buildApp instead.
 */
export async function uploadsRoutes(app: FastifyInstance) {
  if (!usesGcsUploads()) return;

  app.get("/uploads/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
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
