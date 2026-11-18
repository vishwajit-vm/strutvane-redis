/**
 * **Experimental.** The queue-driver interface this package proposes for framework queues
 * (planned for the 0.3 line, hub `docs/18` §10 "Background work"). The framework has no queue
 * contract yet, so this lives here; when the framework defines one, this interface moves there (or
 * adapts to it) and the Redis driver implements the framework's version. Expect breaking changes
 * until then; nothing in the app wires it up automatically.
 *
 * The semantics are Laravel's: at-least-once delivery. A popped job is *reserved* for a visibility
 * timeout; the worker acknowledges it when done, or releases it to retry later. A worker that
 * crashes never acknowledges, so the job becomes available again when its reservation expires.
 * Handlers must therefore be idempotent.
 *
 * @module
 */

/**
 * A job handed to a worker.
 *
 * @experimental
 * @example
 * const job = await driver.pop('emails')
 * if (job) { await handle(JSON.parse(job.payload)); await driver.ack(job) }
 */
export interface ReservedJob {
  readonly id: string
  readonly queue: string
  /** The caller's serialised job (the driver never parses it). */
  readonly payload: string
  /** How many times the job has been reserved, including this one. */
  readonly attempts: number
  /** When the reservation runs out (ms since the epoch, server clock). */
  readonly reservedUntil: number
  /** The driver's own handle for ack/release. Opaque. */
  readonly receipt: string
}

/**
 * Options for {@link QueueDriver.push}.
 *
 * @experimental
 * @example
 * await driver.push('emails', payload, { delaySeconds: 60 })
 */
export interface PushOptions {
  /** Make the job available only after this many seconds. Default 0. */
  readonly delaySeconds?: number
}

/**
 * A queue backend.
 *
 * @experimental
 * @example
 * class SqsDriver implements QueueDriver { … }
 */
export interface QueueDriver {
  /** Add a job; returns its id. */
  push(queue: string, payload: string, options?: PushOptions): Promise<string>
  /** Reserve the next available job, or `undefined` when the queue is empty. */
  pop(
    queue: string,
    options?: { readonly visibilitySeconds?: number },
  ): Promise<ReservedJob | undefined>
  /** The job is done: remove it for good. `false` when its reservation had already expired. */
  ack(job: ReservedJob): Promise<boolean>
  /** Put the job back (after `delaySeconds`) for another attempt. `false` when no longer reserved. */
  release(job: ReservedJob, delaySeconds?: number): Promise<boolean>
  /** Jobs waiting, delayed and reserved. */
  size(queue: string): Promise<number>
  /** Remove every job of the queue; returns how many were removed. */
  clear(queue: string): Promise<number>
}
