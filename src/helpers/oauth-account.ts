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
