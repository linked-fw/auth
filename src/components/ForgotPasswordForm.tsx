import React, { useState } from 'react';
import { useForm, SubmitHandler } from 'react-hook-form';
import style from './ForgotPasswordForm.module.css';
import { Input } from '@_linked/primitives/components/Input';
import { Button } from '@_linked/primitives/components/Button';
import { useStyles } from '@_linked/react/utils/Hooks';
import { Server } from '@_linked/server-utils/utils/Server';
import { packageName } from '../package.js';
import { useTranslate } from '@tolgee/react';

interface ForgotPasswordFormProps {
  className?: string;
}

interface ForgotPasswordFormData {
  email: string;
}

function ForgotPasswordForm({ ...restProps }: ForgotPasswordFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setError,
  } = useForm<ForgotPasswordFormData>();
  const [helperText, setHelperText] = useState('');
  const [loading, setLoading] = useState<boolean>(false);
  const { t } = useTranslate();
  const prefix = 'resetPassword';

  const onResetPassword: SubmitHandler<ForgotPasswordFormData> = (data) => {
    const { email } = data;

    setLoading(true);
    Server.call(packageName, 'sendResetPasswordLink', email)
      .then((res) => {
        if (res) {
          if (res.error) {
            setHelperText(res.error);
          } else {
            setHelperText(
              `We\'ve sent you an email to ${email}. Please kindly check it to reset the password.`
            );
          }
        }
      })
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        setLoading(false);
        reset();
      });
  };

  restProps = useStyles(restProps, style.root);
  return (
    <form {...restProps}>
      <h2>{t(prefix + '.title', 'Reset Password')}</h2>
      <div className={style.FormGroup}>
        <Input
          type={'email'}
          {...register('email', {
            required: t(prefix + '.emailRequired', 'Email field is required'),
          })}
          placeholder={t(
            prefix + '.emailPlaceholder',
            'Enter your valid email'
          )}
        />
        {/* `helperText` was a prop on the legacy TextField. @_linked/primitives' Input is a
            bare <input>; the message is a sibling, exactly like the ErrorMessage
            paragraphs already beside every field in this package. */}
        {helperText && <p className={style.HelperText}>{helperText}</p>}
        {errors.email && (
          <p className={style.ErrorMessage}>
            {t(prefix + '.invalidEmailError', errors.email.message)}
          </p>
        )}
      </div>
      <Button
        color="primary"
        className={style.FormButton}
        disabled={loading}
        onClick={handleSubmit(onResetPassword)}
      >
        {loading
          ? t(prefix + '.sendingInstruction', 'Sending to your email...')
          : t(
              prefix + '.sendInstruction',
              'Send me reset password instructions'
            )}
      </Button>
    </form>
  );
}

export default ForgotPasswordForm;
