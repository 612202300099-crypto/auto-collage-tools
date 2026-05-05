/**
 * logger.ts — Structured logging utility for the Worker.
 *
 * Format: [HH:MM:SS] [LEVEL] [MODULE] message
 * Logs disimpan di memory (ring buffer 500 entries) untuk Dashboard API.
 */
import type { LogEntry, LogLevel } from '../types.ts';

const MAX_LOG_ENTRIES = 500;
const logBuffer: LogEntry[] = [];

function formatTimestamp(): string {
  return new Date().toLocaleTimeString('id-ID', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  INFO:    '\x1b[36m',  // Cyan
  WARN:    '\x1b[33m',  // Yellow
  ERROR:   '\x1b[31m',  // Red
  SUCCESS: '\x1b[32m',  // Green
  DEBUG:   '\x1b[90m',  // Gray
};
const RESET = '\x1b[0m';

function log(level: LogLevel, module: string, message: string): void {
  const timestamp = formatTimestamp();
  const entry: LogEntry = { timestamp, level, module, message };

  // Console output with colors
  const color = LEVEL_COLORS[level];
  const icon = level === 'SUCCESS' ? '✅' : level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : level === 'INFO' ? 'ℹ️' : '🔍';
  console.log(`${color}[${timestamp}] [${level.padEnd(7)}] [${module}]${RESET} ${icon} ${message}`);

  // Buffer for dashboard
  logBuffer.unshift(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.length = MAX_LOG_ENTRIES;
  }
}

export const logger = {
  info:    (module: string, message: string) => log('INFO', module, message),
  warn:    (module: string, message: string) => log('WARN', module, message),
  error:   (module: string, message: string) => log('ERROR', module, message),
  success: (module: string, message: string) => log('SUCCESS', module, message),
  debug:   (module: string, message: string) => log('DEBUG', module, message),

  /** Get recent logs for Dashboard API (newest first) */
  getRecentLogs(limit: number = 100): LogEntry[] {
    return logBuffer.slice(0, limit);
  },

  /** Clear all logs */
  clear(): void {
    logBuffer.length = 0;
  },
};
