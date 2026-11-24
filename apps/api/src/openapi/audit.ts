/**
 * 42Crunch-style audit rules applied to the generated OpenAPI document (offline, no account needed).
 * Mirrors the rules that cost the most points in a 42Crunch audit: security definitions, 401/403
 * on secured operations, error schemas, and bounded data (maxLength / pattern / min-max / maxItems /
 * additionalProperties:false). Returns human-readable violations; empty = pass.
 */
type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function walkSchema(schema: unknown, where: string, out: string[]) {
  if (!isObj(schema)) return;
  if (schema.$ref) return;
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) (schema[key] as unknown[]).forEach((s, i) => walkSchema(s, `${where}.${key}[${i}]`, out));
  }
  const type = schema.type;
  if (type === "object" || schema.properties) {
    const ap = schema.additionalProperties;
    if (ap === undefined || ap === true) out.push(`${where}: object must set additionalProperties:false (or a bounded schema)`);
    if (isObj(ap)) walkSchema(ap, `${where}.additionalProperties`, out);
    for (const [k, v] of Object.entries((schema.properties as Json) ?? {})) walkSchema(v, `${where}.${k}`, out);
  }
  if (type === "string" && !schema.enum && schema.format !== "uuid" && schema.maxLength === undefined) {
    out.push(`${where}: string needs maxLength`);
  }
  if ((type === "integer" || type === "number") && !schema.enum) {
    if (schema.minimum === undefined && schema.exclusiveMinimum === undefined) out.push(`${where}: ${type} needs minimum`);
    if (schema.maximum === undefined && schema.exclusiveMaximum === undefined) out.push(`${where}: ${type} needs maximum`);
  }
  if (type === "array") {
    if (schema.maxItems === undefined) out.push(`${where}: array needs maxItems`);
    walkSchema(schema.items, `${where}[]`, out);
  }
  if (type === undefined && !schema.enum && !schema.anyOf && !schema.oneOf && !schema.allOf && !schema.not) {
    out.push(`${where}: schema has no type (unbounded / any)`);
  }
}

export function auditOpenApi(doc: Json): string[] {
  const out: string[] = [];
  const components = (doc.components ?? {}) as Json;
  const schemes = (components.securitySchemes ?? {}) as Json;

  for (const s of (doc.servers as Json[] | undefined) ?? []) {
    if (!String(s.url).startsWith("https://")) out.push(`servers: ${s.url} is not https`);
  }
  if (!Array.isArray(doc.security) || !(doc.security as unknown[]).length) out.push("no global security");
  for (const [name, scheme] of Object.entries(schemes)) {
    if (isObj(scheme) && scheme.type === "apiKey" && scheme.in === "query") out.push(`securityScheme ${name}: API key in query string`);
  }

  const ids = new Set<string>();
  for (const [path, item] of Object.entries((doc.paths ?? {}) as Record<string, Json>)) {
    for (const [method, raw] of Object.entries(item)) {
      const op = raw as Json;
      const at = `${method.toUpperCase()} ${path}`;
      const id = op.operationId as string | undefined;
      if (!id) out.push(`${at}: missing operationId`);
      else if (ids.has(id)) out.push(`${at}: duplicate operationId ${id}`);
      else ids.add(id);
      if (!op.summary) out.push(`${at}: missing summary`);

      const security = op.security as Json[] | undefined;
      if (!Array.isArray(security)) out.push(`${at}: security not declared (use [] for public)`);
      const secured = Array.isArray(security) && security.some((req) => Object.keys(req).length > 0);
      for (const req of security ?? []) for (const name of Object.keys(req)) {
        if (!(name in schemes)) out.push(`${at}: security scheme ${name} is not defined`);
      }

      const responses = (op.responses ?? {}) as Record<string, Json>;
      const success = Object.keys(responses).find((c) => /^2\d\d$/.test(c));
      if (!success) out.push(`${at}: no 2xx response`);
      if (secured && !responses["401"]) out.push(`${at}: secured operation without 401`);
      if (secured && !responses["403"]) out.push(`${at}: secured operation without 403`);
      if (!responses["500"]) out.push(`${at}: no 500 response`);
      if (!responses["429"]) out.push(`${at}: no 429 response`);
      for (const [code, res] of Object.entries(responses)) {
        const content = (res.content ?? {}) as Record<string, Json>;
        const media = Object.values(content)[0];
        if (!media?.schema) out.push(`${at} ${code}: response has no schema`);
        else walkSchema(media.schema, `${at} ${code}`, out);
      }

      if (["post", "put", "patch"].includes(method)) {
        const body = op.requestBody as Json | undefined;
        const media = body ? Object.values((body.content ?? {}) as Record<string, Json>)[0] : undefined;
        if (!media?.schema) out.push(`${at}: request body has no schema`);
        else walkSchema(media.schema, `${at} body`, out);
      }
      for (const p of (op.parameters as Json[] | undefined) ?? []) {
        const justified = typeof op["x-credential-query-justification"] === "string";
        if (p.in === "query" && !justified && /token|key|secret|password/i.test(String(p.name))) {
          out.push(`${at}: credential-like query parameter ${p.name}`);
        }
        walkSchema(p.schema, `${at} ${p.in}:${p.name}`, out);
      }
    }
  }
  return out;
}
