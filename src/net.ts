import { abortableSleep } from "./auth/device.js";

/**
 * Errors raised before a request leaves this computer (no connection was
 * made), so retrying can't repeat a change. A reset or timeout after
 * connecting is not here: the server may have acted on it.
 */
const CONNECT_FAILURES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

export function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return (
    error instanceof TypeError &&
    typeof code === "string" &&
    CONNECT_FAILURES.has(code)
  );
}

/** Waits before the second and third tries. */
export const CONNECT_RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Some networks drop the first connection to a host now and then. Try up to
 * three times when no connection was made; anything else is returned as is.
 */
export function retryingFetch(
  fetcher: typeof fetch,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetcher(input, init);
      } catch (error) {
        const delay = CONNECT_RETRY_DELAYS_MS[attempt];
        if (
          delay === undefined ||
          !isConnectFailure(error) ||
          init?.signal?.aborted
        )
          throw error;
        await sleep(delay, init?.signal ?? undefined);
      }
    }
  };
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Quick answers show nothing; slower ones show the spinner. */
export const SPINNER_DELAY_MS = 300;

type Stream = { write(text: string): unknown };
export type Progress = <T>(
  work: () => Promise<T>,
  label?: string,
) => Promise<T>;

/** No indicator: --json, scripts, tests. */
export const quiet: Progress = (work) => work();

let current: Progress = quiet;

/** How this run shows that it's waiting: a spinner for a person, nothing otherwise. */
export function setProgress(p: Progress) {
  current = p;
}

/** Run `work` behind this run's indicator. */
export const waiting: Progress = (work, label) => current(work, label);

/**
 * Shows "Waiting for Crisper…" on stderr while `work` runs, so a slow network
 * doesn't look like a frozen terminal. Only for a person at a terminal: the
 * caller passes `quiet` with --json or when stderr isn't a terminal.
 */
export function spinner(
  stream: Stream = process.stderr,
  defaultLabel = "Waiting for Crisper…",
): Progress {
  return async (work, label = defaultLabel) => {
    let frame = 0;
    let ticker: NodeJS.Timeout | undefined;
    const draw = () =>
      stream.write(`\r${FRAMES[frame++ % FRAMES.length]} ${label}`);
    const delay = setTimeout(() => {
      draw();
      ticker = setInterval(draw, 80);
    }, SPINNER_DELAY_MS);
    try {
      return await work();
    } finally {
      clearTimeout(delay);
      if (ticker) {
        clearInterval(ticker);
        stream.write("\r\u001b[2K");
      }
    }
  };
}
