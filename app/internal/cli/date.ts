const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;

export function parseJSTDate(value: string, optionName: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match === null) throw new TypeError(`${optionName} must be YYYY-MM-DD`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
  if (formatJSTDate(result) !== value) {
    throw new TypeError(`${optionName} is not a valid date`);
  }
  return result;
}

export function formatJSTDate(value: Date): string {
  return new Date(value.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}
