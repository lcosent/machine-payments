type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

interface LogRecord {
  level: LogLevel;
  msg: string;
  ts: string;
  ns: string;
  fields: LogFields;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (): LogLevel => {
  const raw = (
    typeof process !== 'undefined' ? process.env['LOG_LEVEL'] : undefined
  )?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
};

const emit = (record: LogRecord): void => {
  if (LEVEL_ORDER[record.level] < LEVEL_ORDER[envLevel()]) return;
  const line = JSON.stringify(record);
  if (record.level === 'error' || record.level === 'warn') {
    console.error(line);
  } else {
    console.error(line);
  }
};

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(ns: string, fields?: LogFields): Logger;
}

export const makeLogger = (ns: string, baseFields: LogFields = {}): Logger => ({
  debug: (msg, fields) =>
    emit({
      level: 'debug',
      msg,
      ts: new Date().toISOString(),
      ns,
      fields: { ...baseFields, ...fields },
    }),
  info: (msg, fields) =>
    emit({
      level: 'info',
      msg,
      ts: new Date().toISOString(),
      ns,
      fields: { ...baseFields, ...fields },
    }),
  warn: (msg, fields) =>
    emit({
      level: 'warn',
      msg,
      ts: new Date().toISOString(),
      ns,
      fields: { ...baseFields, ...fields },
    }),
  error: (msg, fields) =>
    emit({
      level: 'error',
      msg,
      ts: new Date().toISOString(),
      ns,
      fields: { ...baseFields, ...fields },
    }),
  child: (childNs, childFields) =>
    makeLogger(`${ns}.${childNs}`, { ...baseFields, ...childFields }),
});
