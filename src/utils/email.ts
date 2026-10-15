import { EmailOptions, LinkedEmail } from '@_linked/server-utils/utils/LinkedEmail';

/** What became of an auth email: sent to the provider, logged instead (DEV_AUTH), or not sent. */
export type AuthEmailOutcome = 'sent' | 'logged' | 'failed';

/** Whether DEV_AUTH is on (env-cmd may set it as the boolean true). */
function devAuthEnabled(): boolean {
  const devAuth = process.env.DEV_AUTH as unknown;
  return devAuth === 'true' || devAuth === true;
}

/**
 * `value` as text that is safe inside HTML, in element content and in quoted attribute values.
 * A missing value is the empty string. Every value put into an email template goes through it:
 * a name typed in at signup must not add markup to a mail sent from the app's real address.
 */
export function escapeHtml(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `text` with every occurrence of each of `secrets` replaced. */
function redact(text: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

/** The secret query parameters of a link (`token`, `code`), those it has. */
function linkSecrets(url: string): string[] {
  try {
    const params = new URL(url).searchParams;
    return ['token', 'code'].map((name) => params.get(name) ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

/** What an auth email is for: a password reset, an email verification or a sign-in code. */
export type AuthEmailPurpose = 'reset' | 'verify' | 'signin-code';

/**
 * Send an auth email (a reset or verification link, or a sign-in code and link). Never throws:
 * `LinkedEmail.send` throws synchronously when no provider is registered, and a provider may
 * reject.
 *
 * With DEV_AUTH on and no provider registered, the link (and the code, if there is one) is
 * printed to the server log instead and the outcome is `'logged'`. A failure is logged without
 * the address, the link or its secrets.
 */
export async function sendAuthEmail(
  options: EmailOptions,
  devLink: { purpose: AuthEmailPurpose; url: string; code?: string }
): Promise<AuthEmailOutcome> {
  if (devAuthEnabled() && !LinkedEmail.hasDefaultProvider()) {
    const code = devLink.code ? ` (code ${devLink.code})` : '';
    console.info(`[@_linked/auth] dev: ${devLink.purpose} link: ${devLink.url}${code}`);
    return 'logged';
  }
  try {
    await LinkedEmail.send(options);
    return 'sent';
  } catch (error) {
    const addresses = options.to.flatMap((to) => [to.email_address?.address, to.email_address?.name]);
    const secrets = [
      devLink.url,
      ...linkSecrets(devLink.url),
      devLink.code ?? '',
      ...addresses,
      // a link may carry the address too, encoded
      ...addresses.map((address) => (address ? encodeURIComponent(address) : '')),
    ];
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[@_linked/auth] could not send the ${devLink.purpose} email: ${redact(message, secrets)}`);
    return 'failed';
  }
}
