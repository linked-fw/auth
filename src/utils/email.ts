import { EmailOptions, LinkedEmail } from '@_linked/server-utils/utils/LinkedEmail';

/** What became of an auth email: sent to the provider, logged instead (DEV_AUTH), or not sent. */
export type AuthEmailOutcome = 'sent' | 'logged' | 'failed';

/** Whether DEV_AUTH is on (env-cmd may set it as the boolean true). */
function devAuthEnabled(): boolean {
  const devAuth = process.env.DEV_AUTH as unknown;
  return devAuth === 'true' || devAuth === true;
}

/** `text` with every occurrence of each of `secrets` replaced. */
function redact(text: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

/** The `token` query parameter of a link, if it has one. */
function linkToken(url: string): string {
  try {
    return new URL(url).searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

/**
 * Send an auth email (a reset or verification link). Never throws: `LinkedEmail.send` throws
 * synchronously when no provider is registered, and a provider may reject.
 *
 * With DEV_AUTH on and no provider registered, the link is printed to the server log instead
 * and the outcome is `'logged'`. A failure is logged without the address or the link.
 */
export async function sendAuthEmail(
  options: EmailOptions,
  devLink: { purpose: 'reset' | 'verify'; url: string }
): Promise<AuthEmailOutcome> {
  if (devAuthEnabled() && !LinkedEmail.hasDefaultProvider()) {
    console.info(`[@_linked/auth] dev: ${devLink.purpose} link: ${devLink.url}`);
    return 'logged';
  }
  try {
    await LinkedEmail.send(options);
    return 'sent';
  } catch (error) {
    const secrets = [
      devLink.url,
      linkToken(devLink.url),
      ...options.to.flatMap((to) => [to.email_address?.address, to.email_address?.name]),
    ];
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[@_linked/auth] could not send the ${devLink.purpose} email: ${redact(message, secrets)}`);
    return 'failed';
  }
}
