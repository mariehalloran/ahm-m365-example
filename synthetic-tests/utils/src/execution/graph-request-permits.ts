interface Waiter {
  mailbox: string;
  signal: AbortSignal;
  startedAt: number;
  waited: boolean;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}
export interface PermitMeasurements { requests: number; waitedRequests: number; waitMs: number }

/** Grants global and mailbox permits together, so one busy mailbox cannot consume the global queue. */
export class GraphRequestPermits {
  private active = 0;
  private readonly mailboxActive = new Map<string, number>();
  private readonly queue: Waiter[] = [];
  private readonly measurements = new Map<string, PermitMeasurements>();

  constructor(private readonly globalLimit: number, private readonly mailboxLimit: number) {
    if (!Number.isInteger(globalLimit) || globalLimit < 1 || !Number.isInteger(mailboxLimit) || mailboxLimit < 1) {
      throw new Error("Graph request permit limits must be positive integers");
    }
  }

  snapshot(): Map<string, PermitMeasurements> {
    return new Map([...this.measurements].map(([mailbox, value]) => [mailbox, { ...value }]));
  }

  async run<T>(mailbox: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(mailbox.toLowerCase(), signal);
    try { signal.throwIfAborted(); return await operation(); }
    finally { release(); }
  }

  async request(mailbox: string, signal: AbortSignal, operation: () => Promise<Response>): Promise<Response> {
    const release = await this.acquire(mailbox.toLowerCase(), signal);
    try {
      signal.throwIfAborted();
      const response = await operation();
      if (!response.body) { release(); return response; }
      const reader = response.body.getReader();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        release();
      };
      const abort = () => { void reader.cancel(signal.reason).catch(() => undefined).finally(finish); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { finish(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { finish(); controller.error(error); }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); }
          finally { finish(); }
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { release(); throw error; }
  }

  private acquire(mailbox: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        mailbox, signal, resolve, reject, startedAt: performance.now(),
        waited: this.active >= this.globalLimit || (this.mailboxActive.get(mailbox) ?? 0) >= this.mailboxLimit,
        abort: () => {
          signal.removeEventListener("abort", waiter.abort);
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          this.measure(waiter, false);
          reject(signal.reason);
          this.drain();
        },
      };
      this.queue.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
      else this.drain();
    });
  }

  private measure(waiter: Waiter, started: boolean): void {
    const value = this.measurements.get(waiter.mailbox) ?? { requests: 0, waitedRequests: 0, waitMs: 0 };
    if (started) value.requests++;
    if (waiter.waited) {
      value.waitedRequests++;
      value.waitMs += Math.max(0, performance.now() - waiter.startedAt);
    }
    this.measurements.set(waiter.mailbox, value);
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length && this.active < this.globalLimit;) {
      const waiter = this.queue[index]!;
      const mailboxActive = this.mailboxActive.get(waiter.mailbox) ?? 0;
      if (mailboxActive >= this.mailboxLimit) { waiter.waited = true; index++; continue; }
      this.queue.splice(index, 1);
      waiter.signal.removeEventListener("abort", waiter.abort);
      this.active++;
      this.mailboxActive.set(waiter.mailbox, mailboxActive + 1);
      this.measure(waiter, true);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        const remaining = this.mailboxActive.get(waiter.mailbox)! - 1;
        if (remaining) this.mailboxActive.set(waiter.mailbox, remaining);
        else this.mailboxActive.delete(waiter.mailbox);
        this.drain();
      });
    }
    for (const waiter of this.queue) waiter.waited = true;
  }
}
