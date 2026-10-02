import crypto from 'node:crypto';
import type { OAuthProvider } from '../types/auth.js';

export function buildOAuthSubjectLinkId(
  dataRoot: string,
  provider: OAuthProvider,
  subject: string
): string {
  const root = dataRoot?.trim().replace(/\/$/, '');
  if (!root) throw new Error('DATA_ROOT is required for OAuth subject links');
  if (!subject) throw new Error('OAuth subject is required');

  const subjectHash = crypto
    .createHash('sha256')
    .update(`${provider}:${subject}`)
    .digest('hex');
  return `${root}/identity-token/${provider}/${subjectHash}`;
}

/**
 * Which provider a stored subject link belongs to.
 *
 * Links made by {@link buildOAuthSubjectLinkId} carry the provider in their
 * IRI. Older Apple links were created with a generated IRI and only a `sub`,
 * so a link that has a subject but no provider segment is an Apple link.
 */
export function providerOfSubjectLink(link: {
  id?: string;
  sub?: string;
}): OAuthProvider | undefined {
  const match = link?.id?.match(/\/identity-token\/(apple|google|facebook)\/[0-9a-f]{64}$/);
  if (match) return match[1] as OAuthProvider;
  return link?.sub ? 'apple' : undefined;
}
