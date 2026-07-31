export type LogLevel = 'info' | 'warn' | 'error';

export function log(
  level: LogLevel,
  message: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.info(entry);
}
