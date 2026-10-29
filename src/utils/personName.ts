/**
 * A person's name as an app stores and shows it, from a source it does not control (an ID token's
 * claims, a provider's client data, a WebID profile): control characters (C0, C1) and bidirectional
 * controls (U+200E/F, U+202A–E, U+2066–9) removed, whitespace runs collapsed to one space, trimmed,
 * and at most `MAX_PERSON_NAME_LENGTH` characters. `undefined` for a name that is left empty.
 */
export const MAX_PERSON_NAME_LENGTH = 200;

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

export function cleanPersonName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return [...cleaned].slice(0, MAX_PERSON_NAME_LENGTH).join('').trim();
}
