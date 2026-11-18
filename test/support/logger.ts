/** A logger that keeps every entry, for assertions (the framework's Logger contract). */
import type { LogFields, Logger, LogLevel } from '@strutvane/framework/contracts'

/** One log entry. */
export interface LogEntry {
  readonly level: LogLevel
  readonly message: string
  readonly fields: LogFields | undefined
}

/** Records every entry; `child()` shares the same list. */
export class MemoryLogger implements Logger {
  readonly entries: LogEntry[] = []

  trace(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'trace', message, fields })
  }
  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'debug', message, fields })
  }
  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', message, fields })
  }
  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', message, fields })
  }
  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', message, fields })
  }
  fatal(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'fatal', message, fields })
  }
  child(): Logger {
    return this
  }
  isLevelEnabled(): boolean {
    return true
  }
  async flush(): Promise<void> {}
  /** The messages logged at one level, in order. */
  messages(level: LogLevel): string[] {
    return this.entries.filter((entry) => entry.level === level).map((entry) => entry.message)
  }
}
