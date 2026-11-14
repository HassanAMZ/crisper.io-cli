import { type MemoryStore } from "../src/auth/store.js";

/**
 * The one stored token of this kind, whatever folder slot names it, or null.
 * Throws if more than one is stored, so a test never reads the wrong one.
 */
export async function stored(
  secrets: MemoryStore,
  kind: "access" | "refresh",
): Promise<string | null> {
  const names = secrets.names().filter((n) => n.endsWith(`|${kind}`));
  if (names.length > 1)
    throw new Error(`${names.length} ${kind} tokens stored`);
  return names[0] ? secrets.get(names[0]) : null;
}
