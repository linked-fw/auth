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
