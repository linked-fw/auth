/** A stored value as a Date (stores may return dateTime literals as strings). */
export function toDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return isNaN(date.getTime()) ? undefined : date;
}
