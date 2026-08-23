export function rethrowAbort(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
  if (error instanceof Error && error.name === "AbortError") throw error;
}
