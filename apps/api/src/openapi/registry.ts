import type { AnyZodObject, ZodTypeAny } from "zod";

/**
 * Who may call an operation. Maps to OpenAPI `security` in build.ts and must match the route's
 * runtime checks (assertAuthed / assertKitchenStaff / bindCustomerMobile / assertInternalOrRoles).
 */
export type Access =
  | "public" // no auth (browse, health, login)
  | "optionalSession" // works anonymously; a session changes what is returned (e.g. redacted order view)
  | "session" // any signed-in role
  | "customer"
  | "cook" // COOK of that kitchen, or ADMIN
  | "admin"
  | "internal" // X-Internal-Token (Cloud Scheduler / worker) or an ADMIN/COOK session
  | "webhook:razorpay"
  | "webhook:meta"
  | "webhook:logistics";

export type ExtraStatus = 202 | 400 | 404 | 409 | 410 | 502 | 503;

export type ApiOperation = {
  method: "get" | "post" | "put" | "patch" | "delete";
  /** Fastify-style path, e.g. /orders/:publicId */
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  access: Access;
  params?: AnyZodObject;
  query?: AnyZodObject;
  body?: ZodTypeAny;
  bodyContentType?: "application/json" | "multipart/form-data";
  /** Success body (status = successStatus, default 200). */
  response: ZodTypeAny;
  successStatus?: 200 | 201;
  responseContentType?: "application/json" | "text/plain";
  /** Additional documented error statuses beyond the standard set. */
  errors?: Partial<Record<ExtraStatus, string>>;
  /**
   * Third-party-mandated credential in the query string (e.g. Meta's hub.verify_token handshake).
   * Required text explaining why; emitted as x-credential-query-justification and exempts the audit rule.
   */
  credentialQueryJustification?: string;
};

export const defineOperations = (ops: ApiOperation[]) => ops;
