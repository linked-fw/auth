import React, { useEffect, useState } from 'react';
import { useForm, SubmitHandler } from 'react-hook-form';
import style from './SigninWithPasswordForm.module.css';
import { Input } from '@_linked/primitives/components/Input';
import { Dialog } from '@_linked/primitives/components/Dialog';
import { VisuallyHidden } from '@_linked/primitives/components/VisuallyHidden';
import CreateAccountForm from './CreateAccountForm.js';
import ForgotPasswordForm from './ForgotPasswordForm.js';
import { useAuth } from '../hooks/useAuth.js';
import { cl } from '@_linked/react/utils/ClassNames';
import { Server } from '@_linked/server-utils/utils/Server';
import { Button } from '@_linked/primitives/components/Button';
import { packageName } from '../package.js';
import { useSearchParams } from 'react-router-dom';
import { Authentication } from '../shapes/Authentication.js';
import type { AuthenticationResponse, AuthSession } from '../types/auth.js';
import { asset } from '@_linked/core/utils/LinkedFileStorage';
import { useTranslate } from '@tolgee/react';

interface SigninWithPasswordFormProps {
  onCreateAccount?: () => void;
  onLoggedIn?: (data?: AuthenticationResponse) => void;
  onLoginFailed?: () => void;
  onForgotPassword?: () => void;
  className?: string;
  showEmailIcon?: boolean;
  startWithInputField?: boolean;
  buttonClassName?: string;
  onLoadingChange?: (loading: boolean) => void;
}

export const SigninWithPasswordForm = ({
  onCreateAccount,
  onLoggedIn,
  className,
  onLoginFailed,
  startWithInputField,
  onForgotPassword,
  showEmailIcon,
  buttonClassName,
  onLoadingChange, // callback function invoked when the loading state changes, you can pass a function to handle the loading state when call the server
}: SigninWithPasswordFormProps) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
    trigger,
    watch,
    reset,
    resetField,
    getValues,
  } = useForm({ mode: 'all' });

  const [formIsHidden, setFormIsHidden] = useState(false);
  const [showInputField, setShowInputField] = useState(
    startWithInputField || false
  );
  const [showCreateAccountModal, setShowCreateAccountModal] =
    useState<boolean>(false);
  const [showForgotPasswordModal, setShowForgotPasswordModal] =
    useState<boolean>(false);
  const auth = useAuth();
  const [searchParam] = useSearchParams();
  const { t } = useTranslate();
  let prefix = 'signIn';

  const adminLogin = () => {
    return Server.call(
      packageName,
      'signinDevelopment',
      searchParam.get('email')
    ).then((response) => {
      // if (response.auth) {
      //   const result = auth.updateAuth(
      //     response.auth,
      //     response.accessToken,
      //     response.refreshToken,
      //   );
      //   if (onLoggedIn) {
      //     onLoggedIn(result);
      //   }
      //   return true;
      // }
    });
  };
  useEffect(() => {
    if (searchParam.get('email') && process.env.NODE_ENV !== 'production') {
      adminLogin();
    }
  }, [searchParam]);

  const createAccountRedirect = () => {
    onCreateAccount
      ? //if onCreateAccount props available,
        //redirect to that page, otherwise use create account modal popup
        onCreateAccount()
      : setShowCreateAccountModal(true);
  };

  const onSignIn = async (data, e?) => {
    e.preventDefault();
    const { email, password } = data;

    // if onLoadingChange prop is passed, invoke it with true
    if (onLoadingChange) {
      onLoadingChange(true);
    }

    // TODO: replace use from
    Server.call(packageName, 'signinWithPassword', email, password)
      .then((response: any) => {
        if (response?.auth) {
          const result = auth.updateAuth({
            auth: response.auth,
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            // user: response.user,
            // userAccount: response.userAccount,
          });
          //temporary way for admin to login as other users
          if (
            searchParam.get('email') &&
            process.env.NODE_ENV === 'production'
          ) {
            // adminLogin().then((loggedIn) => {
            //   if (!loggedIn && onLoggedIn) {
            //     onLoggedIn(result);
            //   }
            // });
          } else if (onLoggedIn) {
            onLoggedIn(result);
          }
        }
        if (!response || response.error) {
          alert(
            t(
              prefix + '.incorrectEmailPasswordError',
              'Incorrect email and password combination'
            )
          );
          reset();
          setFormIsHidden(false);
          // window.location.reload();

          // if onLoadingChange prop is passed, invoke it with false
          if (onLoadingChange) {
            onLoadingChange(false);
          }
        }
      })
      .catch((err) => {
        console.error('Error signinWithPassword ', err);
      })
      .finally(() => {
        // if onLoadingChange prop is passed, invoke it with false
        if (onLoadingChange) {
          onLoadingChange(false);
        }
      });
  };

  const onNextForm = () => {
    const emailValue = getValues('email');
    const emailError = errors.email;

    if (!emailValue || emailError) {
      trigger('email');
    } else {
      // Rest of your code
      setFormIsHidden(true);
    }
  };

  return (
    <div className={cl(style.root, className)}>
      <form className={style.form}>
        <div className={cl(formIsHidden ? style.hidden : null)}>
          {!showInputField ? (
            <Button
              className={cl(style.fullWidthButton, buttonClassName)}
              onClick={() => setShowInputField(true)}
              variant="outline"
              type="button"
            >
              {/* `startIcon` was a prop on the legacy Button. Button's .Root is already an
                  inline-flex row with a gap, so the icon is simply the first child. */}
              {showEmailIcon && (
                <img
                  src={asset('/images/email.png')}
                  alt="email-icon"
                  className={style.iconButton}
                />
              )}
              {t(prefix + '.email', 'Continue with Email')}
            </Button>
          ) : (
            <div className={style.control}>
              {/* `endAdornment` was a prop on the legacy TextField. @_linked/primitives' Input is a
                  bare <input> with no adornment slot; the trailing control is positioned
                  by the call site, as CN's own SigninForm already does. */}
              <Input
                type={'email'}
                className={style.input}
                placeholder={t(
                  prefix + '.emailPlaceholder',
                  'Type your@email here'
                )}
                {...register('email', {
                  required: true,
                  pattern: {
                    value: /\S+@\S+\.\S+/,
                    message: t(
                      prefix + '.unmatchedEmailError',
                      'Entered value does not match email format'
                    ),
                  },
                })}
                autoComplete="off"
              />
              <button
                className={style.adornment}
                type="button"
                aria-label={t(prefix + '.continue', 'Continue')}
                onClick={onNextForm}
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                >
                  <path
                    d="M4 12h16m0 0-6-6m6 6-6 6"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          )}
          {errors.email && (
            <p className={style.errorMessage}>
              {t(prefix + '.invalidEmailError', 'Please type your valid email')}
            </p>
          )}
        </div>
        <div className={cl(!formIsHidden ? style.hidden : null)}>
          <div className={style.control}>
            <Input
              type={'password'}
              className={style.input}
              placeholder={t(
                prefix + '.passwordPlaceholder',
                'Type your password here'
              )}
              {...register('password', { required: true })}
            />
            <button
              className={style.adornment}
              type="submit"
              aria-label={t(prefix + '.signIn', 'Sign in')}
              onClick={handleSubmit(onSignIn)}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <path
                  d="M4 12h16m0 0-6-6m6 6-6 6"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          {errors.password && (
            <p className={style.errorMessage}>
              {t(prefix + '.passwordError', 'Please type your password')}
            </p>
          )}
        </div>
      </form>
      {showInputField && (
        <div
          className={cl(
            style.bottomSection,
            errors.email || errors.password ? style.ExtraSpace : null
          )}
        >
          <p className={style.createAccount} onClick={createAccountRedirect}>
            {t(prefix + '.createAccount', 'Create account')}
          </p>
          <p
            className={style.forgotPassword}
            onClick={() => setShowForgotPasswordModal(true)}
          >
            {t(prefix + '.forgotPassword', 'Forgot password?')}
          </p>
        </div>
      )}
      {/* Each form keeps its own visible <h2> — it is also rendered outside a dialog —
          so the title Radix needs for aria-labelledby is supplied here and hidden. */}
      <Dialog.Root
        open={showCreateAccountModal}
        onOpenChange={setShowCreateAccountModal}
      >
        <Dialog.Content className={style.modal} aria-describedby={undefined}>
          <VisuallyHidden>
            <Dialog.Title>
              {t('createAccount.title', 'Create Account')}
            </Dialog.Title>
          </VisuallyHidden>
          <CreateAccountForm
            className={style.modalForm}
            onAccountCreated={(auth) => {
              setShowCreateAccountModal(false);
              onLoggedIn(auth);
            }}
          />
        </Dialog.Content>
      </Dialog.Root>
      <Dialog.Root
        open={showForgotPasswordModal}
        onOpenChange={setShowForgotPasswordModal}
      >
        <Dialog.Content className={style.modal} aria-describedby={undefined}>
          <VisuallyHidden>
            <Dialog.Title>
              {t('resetPassword.title', 'Reset Password')}
            </Dialog.Title>
          </VisuallyHidden>
          <ForgotPasswordForm className={style.modalForm} />
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
};
