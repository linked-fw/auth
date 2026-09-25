import Filter from 'bad-words';

/**
 * Profanity filter for user-provided names in auth flows.
 *
 * `bad-words` has false positives for some legitimate names, so keep the
 * allowlist intentionally small and expand it only when a real false positive
 * is found.
 */
const ALLOWLIST_NAMES = ['dick', 'fanny', 'willy', 'cock'];

const filter = new Filter();
filter.removeWords(...ALLOWLIST_NAMES);

export function isCleanName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;

  return !filter.isProfane(trimmed);
}
