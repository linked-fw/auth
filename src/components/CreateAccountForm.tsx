import React, { useState } from 'react';
import { useForm, SubmitHandler } from 'react-hook-form';
import style from './CreateAccountForm.module.css';
import { TextField } from 'lincd-input/components/TextField';
import { Button } from 'lincd-mui-base/components/Button';
import { useStyles } from '@_linked/react/utils/Hooks';
import { Server } from '@_linked/server-utils/utils/Server';
import { packageName } from '../package.js';
import { useAuth } from '../hooks/useAuth.js';
import type { AuthenticationResponse } from '../types/auth.js';
import { useTranslate } from '@tolgee/react';
import { cl } from '@_linked/react/utils/ClassNames';
import { isCleanName } from '../utils/name-validation.js';

interface CreateAccountFormProps {
  className?: string;
  onAccountCreated?: (authentication?: AuthenticationResponse) => void; //props to redirect after account successfully created.
  submitButtonColor?: 'primary' | 'secondary' | 'tertiary';
  submitButtonClassName?: string;
}
interface CreateAccountFormData {
  firstName: string;
  lastName: string;
  email: string;
  confirmEmail: string;
  password: string;
  confirmPassword: string;
}

export function CreateAccountForm({
  onAccountCreated,
  submitButtonColor = 'primary',
  submitButtonClassName,
  ...restProps
}: CreateAccountFormProps) {
  const {
    register,
    handleSubmit,
    getValues,
    watch,
    formState: { errors },
  } = useForm<CreateAccountFormData>();
  const [loading, setLoading] = useState<boolean>(false);
  const [submitFeedback, setSubmitFeedback] = useState<string>('');
  const [isAlertClosed, setIsAlertClosed] = useState<boolean>(false);
  const auth = useAuth();
  const { t } = useTranslate();
  const prefix = 'createAccount';

  const createAccount: SubmitHandler<CreateAccountFormData> = (data) => {
    //validation for password and confirmPassword
    if (watch('password') !== watch('confirmPassword')) {
      return;
    }

    //  set email to lowercase, before sending to server
    data.email = data.email.toLowerCase();

    setLoading(true);
    Server.call(packageName, 'createAccount', data).then((response) => {
      console.log('createAccount response', response);
      if (response?.auth) {
        //update local auth
        const result = auth.updateAuth({
          auth: response.auth,
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
        });
        if (onAccountCreated) {
          onAccountCreated(result);
        }
      }
      if (!response) {
        setSubmitFeedback('Something went wrong. Please contact support');
      }
      if (response && response.error) {
        setSubmitFeedback(response.error);
      }
      setLoading(false);
    });
  };

  const closeAlert = () => {
    setIsAlertClosed(true);
    setSubmitFeedback('');

    setTimeout(() => {
      setIsAlertClosed(false);
    }, 500);
  };

  restProps = useStyles(restProps, style.root);
  return (
    <form {...restProps}>
      <h2>{t(prefix + '.title', 'Create Account')}</h2>
      {submitFeedback && !isAlertClosed ? (
        <div className={style.Alert}>
          <p>{submitFeedback}</p>
          <span className={style.CloseBtn} onClick={closeAlert}>
            ✖
          </span>
        </div>
      ) : null}
      <div className={style.FormGroup}>
        <TextField
          type={'text'}
          placeholder={t(
            prefix + '.firstNamePlaceholder',
            'Enter your first name'
          )}
          {...register('firstName', {
            required: true,
            validate: (value: string) =>
              isCleanName(value) ||
              t(prefix + '.firstNameProfane', 'Please enter your real name.'),
          })}
        />
        {errors.firstName && (
          <p className={style.ErrorMessage}>
            {errors.firstName.type === 'validate'
              ? (errors.firstName.message as string)
              : t(prefix + '.firstNameError', 'First name is required')}
          </p>
        )}

        <TextField
          type={'text'}
          placeholder={t(
            prefix + '.lastNamePlaceholder',
            'Enter your last name'
          )}
          {...register('lastName', {
            validate: (value: string) =>
              !value ||
              isCleanName(value) ||
              t(prefix + '.lastNameProfane', 'Please enter your real name.'),
          })}
        />
        {errors.lastName && (
          <p className={style.ErrorMessage}>
            {errors.lastName.message as string}
          </p>
        )}

        <TextField
          type={'email'}
          placeholder={t(prefix + '.emailPlaceholder', 'Enter your email')}
          {...register('email', { required: true })}
        />
        {errors.email && (
          <p className={style.ErrorMessage}>
            {t(prefix + '.emailError', 'Email is required')}
          </p>
        )}

        <TextField
          type={'email'}
          placeholder={t(
            prefix + '.emailConfirmationPlaceholder',
            'Confirm your email'
          )}
          {...register('confirmEmail', {
            required: true,
          })}
        />
        {errors?.confirmEmail && (
          <p className={style.ErrorMessage}>
            {t(prefix + '.', 'Confirm email is required')}
          </p>
        )}
        {watch('confirmEmail') !== watch('email') &&
        getValues('confirmEmail') ? (
          <p className={style.ErrorMessage}>
            {t(prefix + '.unmatchedEmailError', 'Email did not match')}
          </p>
        ) : null}

        <TextField
          type={'password'}
          placeholder={t(
            prefix + '.passwordPlaceholder',
            'Enter your password'
          )}
          {...register('password', { required: true, minLength: 6 })}
        />
        {errors?.password?.type === 'required' && (
          <p className={style.ErrorMessage}>
            {t(prefix + '.passwordError', 'Password is required')}
          </p>
        )}
        {errors?.password?.type === 'minLength' && (
          <p className={style.ErrorMessage}>
            {t(
              prefix + '.passwordLengthError',
              'Password cannot less than 6 characters'
            )}
          </p>
        )}

        <TextField
          type={'password'}
          placeholder={t(
            prefix + '.passwordConfirmationPlaceholder',
            'Confirm your password'
          )}
          {...register('confirmPassword', {
            required: true,
          })}
        />
        {errors?.confirmPassword && (
          <p className={style.ErrorMessage}>
            {t(
              prefix + '.passwordConfirmationError',
              'Confirm password is required'
            )}
          </p>
        )}
        {watch('confirmPassword') !== watch('password') &&
        getValues('confirmPassword') ? (
          <p className={style.ErrorMessage}>
            {t(prefix + '.unmatchedPasswordError', 'Password did not match')}
          </p>
        ) : null}
      </div>
      <Button
        color={submitButtonColor}
        fullWidth={true}
        className={cl(style.FormButton, submitButtonClassName)}
        disabled={loading}
        onClick={handleSubmit(createAccount)}
      >
        {loading
          ? t(
              prefix + '.loadingCreateAccountButton',
              'Creating your account...'
            )
          : t(prefix + '.createAccountButton', 'Create Account')}
      </Button>
    </form>
  );
}

export default CreateAccountForm;
