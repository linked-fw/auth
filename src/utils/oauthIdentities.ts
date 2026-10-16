import { IdentityToken } from '../shapes/IdentityToken.js';
import { AuthCredential } from '../shapes/AuthCredential.js';
import { providerOfIdentityLink } from '../helpers/oauth-account.js';
import type { OAuthProvider, VerifiedOAuthIdentity } from '../types/auth.js';

/** A stored link from a provider identity (provider + subject) to an account. */
export type OAuthIdentityLink = {
  id: string;
  accountId: string;
  /** Written before links recorded their provider (an Apple link, possibly holding its token). */
  legacy: boolean;
  /**
   * The provider's verified email when the link was made, normalised. Links written before links
   * recorded it have none.
   */
  email?: string;
};

/** How a provider email is compared and stored on a link: trimmed, lower case. */
export function normalizeLinkEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The store reads and writes of OAuth sign-in. Module functions, not provider methods: every
 * method of a backend provider can be dispatched over `/call/<package>/<method>`, and none of
 * these may be reachable from a client. Grouped in an object so tests can stub them.
 */
export const OAuthIdentityStore = {
  /** The links of one provider identity. More than one account means the data is ambiguous. */
  async findLinks(
    provider: OAuthProvider,
    subject: string
  ): Promise<OAuthIdentityLink[]> {
    if (!subject) return [];
    const rows = await IdentityToken.select((token) => [
      token.sub,
      token.identityProvider,
      token.email,
      token.account,
    ]).where((token) => token.sub.equals(subject));
    return (rows || [])
      .filter((row) => providerOfIdentityLink(row) === provider && row.account?.id)
      .map((row) => ({
        id: row.id,
        accountId: row.account.id,
        legacy: !row.identityProvider,
        ...(row.email ? { email: normalizeLinkEmail(row.email) } : {}),
      }));
  },

  /** The providers that have an identity linked to this account. */
  async findLinkedProviders(accountId: string): Promise<OAuthProvider[]> {
    const rows = await IdentityToken.select((token) => [
      token.sub,
      token.identityProvider,
    ]).where((token) => token.account.equals({ id: accountId }));
    return [
      ...new Set(
        (rows || [])
          .map((row) => providerOfIdentityLink(row))
          .filter((provider): provider is OAuthProvider => Boolean(provider))
      ),
    ];
  },

  /**
   * Link a verified provider identity to an account, with the provider's email when the provider
   * verified it (a link is followed only while the identity keeps that email). The provider's
   * token is never stored.
   */
  async createLink(identity: VerifiedOAuthIdentity, accountId: string): Promise<void> {
    await IdentityToken.create({
      sub: identity.subject,
      identityProvider: identity.provider,
      ...(identity.email && identity.emailVerified
        ? { email: normalizeLinkEmail(identity.email) }
        : {}),
      account: { id: accountId },
    } as any);
  },

  /** Record the provider email on a link written before links recorded it. */
  async recordLinkEmail(link: OAuthIdentityLink, email: string): Promise<void> {
    await IdentityToken.update({ email: normalizeLinkEmail(email) } as any).for({ id: link.id });
  },

  /** Remove a link: the identity no longer signs in to that account. */
  async removeLink(link: OAuthIdentityLink): Promise<void> {
    await IdentityToken.delete({ id: link.id });
  },

  /**
   * Bring a link written by an earlier release up to date: record its provider and remove the
   * raw identity token it may hold.
   */
  async upgradeLegacyLink(link: OAuthIdentityLink, provider: OAuthProvider): Promise<void> {
    await IdentityToken.update({ identityProvider: provider, token: null } as any).for({
      id: link.id,
    });
  },

  /** Whether the person has a stored password hash (OAuth-only credentials have none). */
  async personHasPassword(personId: string): Promise<boolean> {
    const credentials = await AuthCredential.select((cred) => [cred.passwordHash]).where(
      (cred) => cred.credentialOf.equals({ id: personId })
    );
    return (credentials || []).some((credential) => Boolean(credential.passwordHash));
  },
};
