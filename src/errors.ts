/**
 * Stable error codes and exit statuses (spec: Output and errors). The code is
 * what agents branch on; the message is safe to print; `next` is the one thing
 * the customer can do about it.
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  auth: 3,
  denied: 4,
  rateLimited: 5,
  customerAction: 6,
  unavailable: 7,
  unconfirmed: 8,
  interrupted: 130,
} as const;

export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "AUTH_REQUIRED"
  | "AUTH_DENIED"
  | "AUTH_EXPIRED"
  | "ACCESS_DENIED"
  | "RATE_LIMITED"
  | "CAPABILITY_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE"
  | "METADATA_INVALID"
  | "NETWORK_ERROR"
  | "SERVER_ERROR"
  | "REVOCATION_UNCONFIRMED"
  | "INTERRUPTED";

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exit: number;
  readonly retryable: boolean;
  readonly next: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      exit: number;
      retryable?: boolean;
      next?: string;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exit = options.exit;
    this.retryable = options.retryable ?? false;
    this.next = options.next ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      next: this.next,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

export const authRequired = () =>
  new CliError("AUTH_REQUIRED", "You are not signed in.", {
    exit: EXIT.auth,
    next: "Run `crisper login`.",
  });

/** Anything we didn't anticipate: keep the message generic, never echo server text. */
export function sanitize(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new CliError("INTERRUPTED", "Interrupted.", {
      exit: EXIT.interrupted,
    });
  return new CliError("SERVER_ERROR", "Something went wrong on our side.", {
    exit: EXIT.failure,
    retryable: true,
    next: "Try again in a minute. If it keeps failing, email support@crisper.io.",
  });
}
