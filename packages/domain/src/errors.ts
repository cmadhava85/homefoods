/**
 * Typed API/domain failure — prefer this over regex-matching Error.message for HTTP status.
 */
export class DomainError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = "domain_error") {
    super(message);
    this.name = "DomainError";
    this.statusCode = statusCode;
    this.code = code;
  }

  static notFound(message = "Not found") {
    return new DomainError(message, 404, "not_found");
  }

  static conflict(message: string) {
    return new DomainError(message, 409, "conflict");
  }

  static forbidden(message: string) {
    return new DomainError(message, 403, "forbidden");
  }

  static unauthorized(message = "Unauthorized") {
    return new DomainError(message, 401, "unauthorized");
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
