import type { OAuthProvider } from '../types/auth.js';

/**
 * Providers whose email claim proves that the signer controls the address. Google and Apple
 * state it explicitly (`email_verified`, which their helpers require). Facebook's Graph API
 * returns an email without any verification flag, so a Facebook email never attaches an
 * identity to an account that already exists.
 */
export const EMAIL_VERIFYING_PROVIDERS: readonly OAuthProvider[] = ['google', 'apple'];

/**
 * The `action` of a sign-in refused because the email belongs to an account the provider
 * identity may not be attached to on its own. The user signs in the way they did before and
 * connects the provider from inside that session with `linkOAuthIdentity`.
 */
export const LINK_REQUIRES_SIGN_IN_ACTION = 'sign_in_to_link';

/** What `signinOAuth` knows about an existing account whose email matched. */
export type EmailMatchedAccountFacts = {
  /** The account's person has a verified email (`personEmailVerified`). */
  emailVerified: boolean;
  /** The account's person has a stored password hash. */
  hasPassword: boolean;
  /** The providers that already have an identity linked to the account. */
  linkedProviders: OAuthProvider[];
};

/**
 * Decide whether a verified provider identity that matched NO linked identity may be attached,
 * by email, to an account that already exists.
 *
 * The provider must vouch for the email (see {@link EMAIL_VERIFYING_PROVIDERS}). Then:
 *
 * - an account whose email is verified is the same person's: one verified email is one account
 *   (one email, one WebID), so the identity is attached whatever else the account has, a password
 *   or other sign-in methods;
 * - an account whose email was never verified may have been registered by somebody who typed in
 *   this address in advance and is waiting for the owner to arrive (pre-account hijacking: account
 *   creation does not verify email ownership). It is attached only when nothing about it could
 *   belong to someone else: no password, no identity at a provider whose email is not verified,
 *   and no different identity at this same provider.
 *
 * Everything else fails closed with `action: 'sign_in_to_link'`.
 *
 * `matchPasswordAccounts` lets the provider's verified email reach an unverified account that has
 * a password, as sign-in by email did before the pre-account hijacking rule. It is an app's
 * opt-in (see {@link matchPasswordAccountsFromEnv}) for accounts created before emails were
 * verified; it reopens that risk, so it is off by default.
 */
export function decideEmailMatchedAccount(input: {
  provider: OAuthProvider;
  emailVerified: boolean;
  existing: EmailMatchedAccountFacts;
  matchPasswordAccounts?: boolean;
}): { link: true } | { error: string; action: string } {
  const refuse = (reason: string) => ({
    error:
      `An account with this email already exists${reason}. ` +
      `Sign in the way you did before, then connect ${input.provider} from your account.`,
    action: LINK_REQUIRES_SIGN_IN_ACTION,
  });

  if (!input.emailVerified || !EMAIL_VERIFYING_PROVIDERS.includes(input.provider)) {
    return refuse('');
  }
  if (input.existing.emailVerified) {
    return { link: true };
  }
  if (input.existing.hasPassword && !input.matchPasswordAccounts) {
    return refuse(' and has a password');
  }
  if (input.existing.linkedProviders.includes(input.provider)) {
    return refuse(` and is connected to a different ${input.provider} account`);
  }
  if (
    input.existing.linkedProviders.some(
      (linked) => !EMAIL_VERIFYING_PROVIDERS.includes(linked)
    )
  ) {
    return refuse('');
  }
  return { link: true };
}

/**
 * `AUTH_OAUTH_MATCH_PASSWORD_ACCOUNTS=true` turns on `matchPasswordAccounts` for
 * {@link decideEmailMatchedAccount}.
 */
export function matchPasswordAccountsFromEnv(env: Record<string, string | undefined> = process.env) {
  return env.AUTH_OAUTH_MATCH_PASSWORD_ACCOUNTS === 'true';
}

/**
 * The provider a stored identity link belongs to. Rows written before links recorded their
 * provider were only ever made by Apple sign-in, so a row with a subject and no provider is an
 * Apple link.
 */
export function providerOfIdentityLink(link: {
  identityProvider?: string | null;
  sub?: string | null;
}): OAuthProvider | undefined {
  const provider = link?.identityProvider;
  if (provider === 'google' || provider === 'apple' || provider === 'facebook') {
    return provider;
  }
  if (provider) return undefined;
  return link?.sub ? 'apple' : undefined;
}
