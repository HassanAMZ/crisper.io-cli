/** True for a JSON object (or array) from the server or a sign-in response. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The value's fields when it is an object; anything else reads as no fields. */
export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
