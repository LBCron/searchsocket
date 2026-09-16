export type SearchSocketErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "ROUTE_MAPPING_FAILED"
  | "VECTOR_BACKEND_UNAVAILABLE"
  | "SEARCH_NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR"
  | "BUILD_MANIFEST_NOT_FOUND"
  | "BUILD_SERVER_FAILED"
  /** A safety check refused an index mutation; nothing was written. See `IndexStats.writesRefused`. */
  | "INDEX_WRITES_REFUSED";

export interface SearchSocketErrorOptions {
  status?: number;
  /**
   * The underlying error. Preserved for logging and diagnosis; never included
   * in a public error payload, which could leak credentials or internals.
   */
  cause?: unknown;
}

/**
 * Marks a SearchSocket error across bundles. Each published entry point
 * (`searchsocket`, `searchsocket/sveltekit`, the CLI, CommonJS and ESM builds)
 * carries its own copy of this class, so a plain prototype check fails for an
 * error thrown by one entry and caught with the class imported from another —
 * a config file that throws via `searchsocket`, or an app catching an error
 * from `searchsocket/sveltekit`. `Symbol.for` is shared by every copy.
 */
const SEARCHSOCKET_ERROR_BRAND = Symbol.for("searchsocket.SearchSocketError");

export class SearchSocketError extends Error {
  public readonly code: SearchSocketErrorCode;
  public readonly status: number;

  static [Symbol.hasInstance](value: unknown): boolean {
    // A subclass keeps ordinary prototype semantics; only the base class
    // recognises an instance created by another bundle's copy.
    if (this !== SearchSocketError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<PropertyKey, unknown>)[SEARCHSOCKET_ERROR_BRAND] === true
    );
  }

  constructor(
    code: SearchSocketErrorCode,
    message: string,
    statusOrOptions: number | SearchSocketErrorOptions = 500
  ) {
    const options: SearchSocketErrorOptions =
      typeof statusOrOptions === "number" ? { status: statusOrOptions } : statusOrOptions;
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SearchSocketError";
    Object.defineProperty(this, SEARCHSOCKET_ERROR_BRAND, { value: true });
    this.code = code;
    this.status = options.status ?? 500;
  }
}

export function toErrorPayload(error: unknown): {
  error: {
    code: SearchSocketErrorCode;
    message: string;
  };
} {
  if (error instanceof SearchSocketError) {
    return {
      error: {
        code: error.code,
        message: error.message
      }
    };
  }

  // An unexpected error's message is not a deliberate public string — it can
  // carry a credential, a file path, or an internal URL. Typed errors say what
  // they mean and are safe; everything else is reported generically, with the
  // detail left for the server log.
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal error"
    }
  };
}
