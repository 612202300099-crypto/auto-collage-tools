/**
 * workerPool.ts — Concurrent task execution with configurable parallelism.
 *
 * Implements a semaphore-based pool pattern for running multiple
 * async tasks concurrently while respecting a max concurrency limit.
 *
 * This is NOT thread-based (Node.js is single-threaded event loop).
 * Instead, it limits how many async operations run simultaneously,
 * preventing memory exhaustion from too many large canvases in flight.
 */

export class WorkerPool {
  private maxConcurrency: number;
  private running: number = 0;
  private queue: (() => void)[] = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  /**
   * Execute an async task within the pool's concurrency limit.
   * If the limit is reached, the task waits until a slot opens.
   */
  async execute<T>(task: () => Promise<T>): Promise<T> {
    // Wait for available slot
    if (this.running >= this.maxConcurrency) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }

    this.running++;

    try {
      return await task();
    } finally {
      this.running--;
      // Release next waiting task
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /**
   * Execute multiple tasks concurrently, returning results in order.
   * Failed tasks return their error instead of throwing.
   */
  async executeAll<T>(tasks: (() => Promise<T>)[]): Promise<(T | Error)[]> {
    return Promise.all(
      tasks.map(task =>
        this.execute(task).catch(err =>
          err instanceof Error ? err : new Error(String(err))
        )
      )
    );
  }

  /** Current number of running tasks */
  get activeCount(): number {
    return this.running;
  }

  /** Number of tasks waiting for a slot */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Update max concurrency dynamically */
  setMaxConcurrency(n: number): void {
    this.maxConcurrency = Math.max(1, n);
    // Release queued tasks if new limit allows
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
