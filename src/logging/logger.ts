export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function parseLogLevel(value: string): LogLevel {
  const map: Record<string, LogLevel> = {
    debug: LogLevel.DEBUG,
    info: LogLevel.INFO,
    warn: LogLevel.WARN,
    error: LogLevel.ERROR,
  };
  return map[value.toLowerCase()] ?? LogLevel.INFO;
}

function write(level: LogLevel, tag: string, msg: string, data?: unknown): void {
  if (level < currentLevel) return;
  const prefix = `[${LEVEL_NAMES[level]}][${tag}]`;
  const out = data !== undefined ? `${prefix} ${msg} ${JSON.stringify(data)}` : `${prefix} ${msg}`;
  if (level >= LogLevel.ERROR) {
    console.error(out);
  } else {
    console.log(out);
  }
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, data?: unknown) => write(LogLevel.DEBUG, tag, msg, data),
    info: (msg: string, data?: unknown) => write(LogLevel.INFO, tag, msg, data),
    warn: (msg: string, data?: unknown) => write(LogLevel.WARN, tag, msg, data),
    error: (msg: string, data?: unknown) => write(LogLevel.ERROR, tag, msg, data),
  };
}
