export interface ExecutionClock {
  wallNow(): number;
  monotonicNow(): number;
  schedule(delayMs: number, callback: () => void): () => void;
  timeout(delayMs: number): AbortSignal;
}

export const systemClock: ExecutionClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
  timeout: delayMs => AbortSignal.timeout(delayMs),
};
