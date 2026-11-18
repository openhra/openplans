import { AsyncLocalStorage } from "node:async_hooks";

interface Waiting {
  start(): void;
  cancel(): void;
}

/** Serialize calculations without retaining requests after cancellation. */
export class CalculationQueue {
  private active = false;
  private waiting: Waiting[] = [];

  run<T>(signal: AbortSignal, calculate: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active && this.waiting.length >= 8)
      return Promise.reject(new Error("calculation_queue_full"));
    const inRequest = AsyncLocalStorage.snapshot();
    return new Promise<T>((resolve, reject) => {
      const job: Waiting = {
        start: () =>
          inRequest(() => {
            signal.removeEventListener("abort", job.cancel);
            this.active = true;
            void Promise.resolve()
              .then(() => {
                signal.throwIfAborted();
                return calculate();
              })
              .then(resolve, reject)
              .finally(() => {
                this.active = false;
                this.waiting.shift()?.start();
              });
          }),
        cancel: () => {
          const index = this.waiting.indexOf(job);
          if (index >= 0) this.waiting.splice(index, 1);
          signal.removeEventListener("abort", job.cancel);
          reject(signal.reason);
        },
      };
      if (this.active) {
        this.waiting.push(job);
        signal.addEventListener("abort", job.cancel, { once: true });
      } else job.start();
    });
  }
}
