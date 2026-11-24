import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";

export const UploadNameParams = z.object({
  name: z
    .string()
    .max(120)
    .regex(/^(menu|concern|img)-[a-zA-Z0-9._-]+$/)
    .describe("Upload object name (menu-… / concern-…)"),
});

export const uploadsOperations = defineOperations([
  {
    method: "get",
    path: "/uploads/:name",
    operationId: "getUpload",
    summary:
      "Uploaded photo (GCS mode). Menu photos in the public bucket answer 301 to their storage.googleapis.com URL; others stream image/* bytes.",
    tags: ["Uploads"],
    access: "public",
    params: UploadNameParams,
    responseContentType: "text/plain",
    response: z.string().max(10_000_000).describe("Image bytes (image/* content-type)"),
    errors: { 404: "No such upload" },
  },
]);
