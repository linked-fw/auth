import type { OAuthProvider } from '../types/auth.js';

export type ProviderSubjectCandidate<Account> = {
  account: Account;
  email?: string;
};

export type OAuthAccountResolution<Account> =
  | { account: Account; email?: string }
  | { email: string }
  | { error: string };

function uniqueAccounts<Account>(accounts: Account[]): Account[] {
  return accounts.filter(
    (account, index, all) =>
      all.findIndex((other) => {
        if (other === account) return true;
        const otherId = (other as { id?: string })?.id;
        const accountId = (account as { id?: string })?.id;
        return Boolean(otherId && accountId && otherId === accountId);
      }) === index
  );
}

export function resolveVerifiedEmailAccount<Account>(
  accounts: Account[]
): { account?: Account; error?: string } {
  const unique = uniqueAccounts(accounts);
  if (unique.length > 1) {
    return {
      error:
        'This email is linked to multiple accounts. Please contact support.',
    };
  }
  return { account: unique[0] };
}

export function resolveOAuthAccountInput<Account>(input: {
  provider: OAuthProvider;
  verifiedEmail?: string;
  subjectCandidates?: Array<ProviderSubjectCandidate<Account>>;
}): OAuthAccountResolution<Account> {
  const candidateAccounts = uniqueAccounts(
    (input.subjectCandidates || []).map((candidate) => candidate.account)
  );
  const candidates = candidateAccounts.map(
    (account) =>
      input.subjectCandidates!.find((candidate) => candidate.account === account ||
        ((candidate.account as { id?: string })?.id &&
          (candidate.account as { id?: string }).id ===
            (account as { id?: string })?.id))!
  );
  if (candidates.length > 1) {
    return {
      error:
        'This social identity is linked to multiple accounts. Please contact support.',
    };
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    const email = input.verifiedEmail || candidate.email;
    return { account: candidate.account, email };
  }

  const email = input.verifiedEmail?.trim().toLowerCase();
  if (!email) {
    return {
      error: `Could not find a verified email for ${input.provider} sign-in.`,
    };
  }

  return { email };
}

/**
 * Providers whose email claim we treat as proof that the signer controls the
 * address. Google and Apple say so explicitly (`email_verified`, which the
 * helpers already require). Facebook's Graph API returns an email without any
 * verification flag, so a Facebook email is never used to attach to an
 * account that already exists.
 */
export const EMAIL_VERIFYING_PROVIDERS: readonly OAuthProvider[] = [
  'google',
  'apple',
];

export type EmailMatchedAccountFacts = {
  /** The existing account's person has a stored password hash. */
  hasPassword: boolean;
  /** Providers that already have a subject link to the existing account. */
  linkedProviders: OAuthProvider[];
};

export const LINK_REQUIRES_SIGN_IN_ACTION = 'sign_in_to_link';

/**
 * Decide whether a verified provider identity that matched NO subject link may
 * be attached, by email, to an account that already exists.
 *
 * Linking by email is where account takeover happens, so this only allows it
 * when nothing about the existing account could belong to someone else:
 *
 * - the provider must vouch for the email (see {@link EMAIL_VERIFYING_PROVIDERS});
 * - the account must have no password. Account creation does not verify email
 *   ownership, so a password account may have been registered by somebody who
 *   typed in this address in advance and is waiting for the owner to arrive;
 * - the account must not already be connected to a provider whose email is
 *   not verified (same reasoning), nor to a different identity at this same
 *   provider.
 *
 * Everything else fails closed with an action telling the user to sign in the
 * way they did before and connect the provider from inside the session
 * (`linkOAuthIdentity`), which is the proof of ownership this path lacks.
 */
export function decideEmailMatchedAccount(input: {
  provider: OAuthProvider;
  existing: EmailMatchedAccountFacts;
}): { link: true } | { error: string; action: string } {
  const refuse = (reason: string) => ({
    error: `An account with this email already exists${reason}. Sign in the way you did before, then connect ${input.provider} from your account.`,
    action: LINK_REQUIRES_SIGN_IN_ACTION,
  });

  if (!EMAIL_VERIFYING_PROVIDERS.includes(input.provider)) {
    return refuse('');
  }
  if (input.existing.hasPassword) {
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
