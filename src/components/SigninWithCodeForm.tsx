import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslate } from '@tolgee/react';
import { Input } from '@_linked/primitives/components/Input';
import { Button } from '@_linked/primitives/components/Button';
import { cl } from '@_linked/react/utils/ClassNames';
import { useAuth } from '../hooks/useAuth.js';
import type { AuthenticationResponse } from '../types/auth.js';
import style from './SigninWithCodeForm.module.css';

interface SigninWithCodeFormProps {
  /** Called once signed in, with the auth response. */
  onLoggedIn?: (data: AuthenticationResponse) => void;
  /** An email to start with, e.g. one the user already typed elsewhere. */
  email?: string;
  className?: string;
}

/**
 * Sign in with a code sent by email: asks for the email, sends the code, then asks for the code.
 *
 * It is also the page behind the link in that email (`/auth/signin-code?email=…&code=…`): with
 * both in the URL it shows the code filled in, and signs in when the user presses Sign in. It
 * never signs in on its own: mail scanners open links, and would use the code up.
 */
export default function SigninWithCodeForm({
  onLoggedIn,
  email: initialEmail,
  className,
}: SigninWithCodeFormProps) {
  const [searchParams] = useSearchParams();
  const linkEmail = searchParams.get('email');
  const linkCode = searchParams.get('code');
  const auth = useAuth();
  const { t } = useTranslate();
  const prefix = 'signinCode';

  const [email, setEmail] = useState(linkEmail || initialEmail || '');
  const [code, setCode] = useState(linkEmail && linkCode ? linkCode : '');
  const [step, setStep] = useState<'email' | 'code' | 'signedIn'>(
    linkEmail && linkCode ? 'code' : 'email'
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [helperText, setHelperText] = useState('');

  const signin = async (signinEmail: string, signinCode: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await auth.signinWithCode(signinEmail, signinCode);
      if ('error' in result) {
        setError(result.error);
        setStep('code');
      } else {
        setStep('signedIn');
        onLoggedIn?.(result);
      }
    } catch (err) {
      console.warn('@_linked/auth: could not sign in with a code', err);
      setError(t(prefix + '.failed', "Couldn't sign in. Please try again later."));
    } finally {
      setBusy(false);
    }
  };

  // a route reused for another link shows that link's email and code
  useEffect(() => {
    if (!linkEmail || !linkCode) return;
    setEmail(linkEmail);
    setCode(linkCode);
    setStep('code');
    setError('');
  }, [linkEmail, linkCode]);

  const sendCode = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!/\S+@\S+\.\S+/.test(email)) {
      setError(t(prefix + '.invalidEmailError', 'Please type your valid email'));
      return;
    }
    setBusy(true);
    setError('');
    setHelperText('');
    try {
      const result = await auth.sendSigninCode(email);
      if (result === true) {
        setStep('code');
        setCode('');
        setHelperText(
          t(prefix + '.codeSent', 'We sent a sign-in code to {email}.', { email: email.trim() })
        );
      } else {
        setError(result.error);
      }
    } catch (err) {
      console.warn('@_linked/auth: could not send a sign-in code', err);
      setError(t(prefix + '.sendFailed', "Sorry, we couldn't send the code, please try again later"));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim()) {
      setError(t(prefix + '.codeRequired', 'Please type the code from the email'));
      return;
    }
    signin(email, code);
  };

  if (step === 'signedIn') {
    return (
      <div className={cl(style.root, className)}>
        <p className={style.HelperText}>{t(prefix + '.signedIn', 'You are signed in.')}</p>
      </div>
    );
  }

  if (step === 'email') {
    return (
      <form className={cl(style.root, className)} onSubmit={sendCode}>
        <Input
          type="email"
          className={style.input}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t(prefix + '.emailPlaceholder', 'Type your@email here')}
          autoComplete="email"
          aria-label={t(prefix + '.email', 'Email')}
        />
        {error && (
          <p className={style.ErrorMessage} role="alert">
            {error}
          </p>
        )}
        <Button className={style.button} type="submit" disabled={busy}>
          {busy ? t(prefix + '.sending', 'Sending...') : t(prefix + '.sendCode', 'Email me a code')}
        </Button>
      </form>
    );
  }

  return (
    <form className={cl(style.root, className)} onSubmit={submitCode}>
      {helperText && <p className={style.HelperText}>{helperText}</p>}
      <Input
        type="text"
        className={style.codeInput}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={t(prefix + '.codePlaceholder', '123456')}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label={t(prefix + '.code', 'Sign-in code')}
      />
      {error && (
        <p className={style.ErrorMessage} role="alert">
          {error}
        </p>
      )}
      <Button className={style.button} type="submit" disabled={busy}>
        {busy ? t(prefix + '.signingIn', 'Signing in...') : t(prefix + '.signIn', 'Sign in')}
      </Button>
      <div className={style.links}>
        <button type="button" className={style.link} disabled={busy} onClick={() => sendCode()}>
          {t(prefix + '.resend', 'Send a new code')}
        </button>
        <button
          type="button"
          className={style.link}
          disabled={busy}
          onClick={() => {
            setStep('email');
            setError('');
            setHelperText('');
          }}
        >
          {t(prefix + '.otherEmail', 'Use another email')}
        </button>
      </div>
    </form>
  );
}
