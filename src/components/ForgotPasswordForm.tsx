import React, { useState } from 'react';
import { useForm, SubmitHandler } from 'react-hook-form';
import style from './ForgotPasswordForm.module.css';
import { Modal } from 'lincd-mui-base/components/Modal';
import { TextField } from 'lincd-input/components/TextField';
import { Button } from 'lincd-mui-base/components/Button';
import { useStyles } from '@_linked/react/utils/Hooks';
import { Server } from '@_linked/server-utils/utils/Server';
import { packageName } from '../package.js';
import { useTranslate } from '@_linked/translation/react';

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
        <TextField
          type={'email'}
          {...register('email', {
            required: t(prefix + '.emailRequired', 'Email field is required'),
          })}
          placeholder={t(
            prefix + '.emailPlaceholder',
            'Enter your valid email'
          )}
          helperText={helperText}
        />
        {errors.email && (
          <p className={style.ErrorMessage}>
            {t(prefix + '.invalidEmailError', errors.email.message)}
          </p>
        )}
      </div>
      <Button
        color="primary"
        fullWidth={true}
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
