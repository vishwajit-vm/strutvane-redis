/**
 * A logger that resolves the app's logger on first use. Providers build services in `register()`,
 * before the app's logger may be bound (a provider can replace it), so they hold this instead.
 *
 * @module
 */
import type { Logger } from '@strutvane/framework/contracts'

/**
 * Wrap a logger factory; the factory runs once, on the first log call.
 *
 * @example
 * const logger = lazyLogger(() => app.make(LoggerToken).child({ component: 'redis' }))
 */
export function lazyLogger(resolve: () => Logger): Logger {
  let logger: Logger | undefined
  const get = (): Logger => {
    logger ??= resolve()
    return logger
  }
  return {
    trace: (msg, fields) => get().trace(msg, fields),
    debug: (msg, fields) => get().debug(msg, fields),
    info: (msg, fields) => get().info(msg, fields),
    warn: (msg, fields) => get().warn(msg, fields),
    error: (msg, fields) => get().error(msg, fields),
    fatal: (msg, fields) => get().fatal(msg, fields),
    child: (bindings) => get().child(bindings),
    isLevelEnabled: (level) => get().isLevelEnabled(level),
    flush: () => get().flush(),
  }
}
