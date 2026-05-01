/**
 * Namespaced logger factory. Mirrors Lark's `larkLogger('category')` pattern
 * so log lines carry a stable prefix like `[helloagent/channel/monitor]`,
 * making it easy to grep daemon output for plugin activity.
 *
 * No external dependencies — falls back to console.* with a small wrapper
 * so the runtime doesn't need pino/winston/etc. The host's log pipeline
 * captures stdout/stderr regardless.
 */
type LogLevel = "info" | "warn" | "error" | "debug";

export type HaLogger = {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
};

function shouldLog(level: LogLevel): boolean {
  if (level !== "debug") return true;
  return process.env.HELLOAGENT_DEBUG === "1" || process.env.DEBUG?.includes("helloagent") === true;
}

function format(prefix: string, msg: string, meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return `[${prefix}] ${msg}`;
  let metaStr: string;
  try {
    metaStr = JSON.stringify(meta);
  } catch {
    metaStr = "{...unserializable}";
  }
  return `[${prefix}] ${msg} ${metaStr}`;
}

export function haLogger(category: string): HaLogger {
  const prefix = `helloagent/${category}`;
  return {
    info(msg, meta) {
      if (!shouldLog("info")) return;
      // eslint-disable-next-line no-console
      console.log(format(prefix, msg, meta));
    },
    warn(msg, meta) {
      if (!shouldLog("warn")) return;
      // eslint-disable-next-line no-console
      console.warn(format(prefix, msg, meta));
    },
    error(msg, meta) {
      if (!shouldLog("error")) return;
      // eslint-disable-next-line no-console
      console.error(format(prefix, msg, meta));
    },
    debug(msg, meta) {
      if (!shouldLog("debug")) return;
      // eslint-disable-next-line no-console
      console.log(format(prefix, msg, meta));
    },
  };
}
