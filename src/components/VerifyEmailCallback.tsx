import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@_linked/primitives/components/Button';
import { useTranslate } from '@tolgee/react';
import { useAuth } from '../hooks/useAuth.js';
import style from './VerifyEmailCallback.module.css';

interface VerifyEmailCallbackProps {
  /** Called once the email is verified, e.g. to redirect. */
  onEmailVerified?: () => void;
}

type VerifyState =
  | { status: 'verifying' }
  | { status: 'verified' }
  | { status: 'invalid'; error: string };

/**
 * The page behind the emailed verification link (`/auth/verify-email?token=…`). Redeems the
 * token once; works signed out too, and when signed in offers a new link if this one failed.
 */
export default function VerifyEmailCallback({ onEmailVerified }: VerifyEmailCallbackProps) {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const auth = useAuth();
  const { t } = useTranslate();
  const prefix = 'verifyEmail';
  const [state, setState] = useState<VerifyState>({ status: 'verifying' });
  const [resendText, setResendText] = useState('');
  const [resending, setResending] = useState(false);
  // a token is single-use: a second call (StrictMode, a re-render) would report it as used
  const requested = useRef(false);

  useEffect(() => {
    // wait for the session check: when signed in, verifying refreshes the session
    if (auth.validating || requested.current) return;
    requested.current = true;
    if (!token) {
      setState({
        status: 'invalid',
        error: t(prefix + '.invalidLink', 'This verification link is invalid or has expired.'),
      });
      return;
    }
    auth
      .verifyEmail(token)
      .then((result) => {
        if ('verified' in result && result.verified === true) {
          setState({ status: 'verified' });
          onEmailVerified?.();
        } else {
          setState({
            status: 'invalid',
            error:
              'error' in result && result.error
                ? result.error
                : t(prefix + '.invalidLink', 'This verification link is invalid or has expired.'),
          });
        }
      })
      .catch((err) => {
        console.warn('@_linked/auth: could not verify the email', err);
        setState({
          status: 'invalid',
          error: t(prefix + '.failed', "Couldn't verify your email. Please try again later."),
        });
      });
  }, [token, auth.validating]);

  const resend = async () => {
    setResending(true);
    setResendText('');
    try {
      const result = await auth.resendEmailVerification();
      if ('sent' in result) {
        setResendText(t(prefix + '.resent', "We've sent you a new verification link."));
      } else if ('verified' in result) {
        setState({ status: 'verified' });
      } else {
        setResendText(result.error);
      }
    } catch (err) {
      console.warn('@_linked/auth: could not resend the verification email', err);
      setResendText(
        t(prefix + '.resendFailed', "Sorry, we couldn't send the email, please try again later")
      );
    } finally {
      setResending(false);
    }
  };

  return (
    <div className={style.Fallback}>
      <div className={style.root}>
        {state.status === 'verifying' && (
          <p>{t(prefix + '.verifying', 'Verifying your email...')}</p>
        )}
        {state.status === 'verified' && (
          <>
            <h2>{t(prefix + '.verifiedTitle', 'Email verified')}</h2>
            <p>{t(prefix + '.verified', 'Thank you, your email address is verified.')}</p>
          </>
        )}
        {state.status === 'invalid' && (
          <>
            <h2>{t(prefix + '.invalidTitle', "We couldn't verify your email")}</h2>
            <p className={style.ErrorMessage} role="alert">
              {state.error}
            </p>
            {auth.userAccount && (
              <Button color="primary" disabled={resending} onClick={resend}>
                {resending
                  ? t(prefix + '.resending', 'Sending...')
                  : t(prefix + '.resend', 'Send me a new link')}
              </Button>
            )}
            {resendText && <p className={style.HelperText}>{resendText}</p>}
          </>
        )}
      </div>
    </div>
  );
}
