import React, { useState } from 'react';
import { useForm, SubmitHandler, set } from 'react-hook-form';
import style from './CreateNewPasswordForm.module.css';
import { Input } from '@_linked/primitives/components/Input';
import { Button } from '@_linked/primitives/components/Button';
import { useStyles } from '@_linked/react/utils/Hooks';
import { Server } from '@_linked/server-utils/utils/Server';
import { packageName } from '../package.js';
import { useAuth } from '../hooks/useAuth.js';
import { Dialog } from '@capacitor/dialog';

interface CreateNewPasswordFormProps {
  className?: string;
  token?: string;
  onPasswordIsReset?: () => void;
}

interface CreateNewPasswordFormData {
  password: string;
  confirmPassword: string;
}

export function CreateNewPasswordForm({
  token,
  onPasswordIsReset,
  ...restProps
}: CreateNewPasswordFormProps) {
  const {
    register,
    handleSubmit,
    getValues,
    watch,
    formState: { errors },
  } = useForm<CreateNewPasswordFormData>();
  const auth = useAuth();
  const [loading, setLoading] = useState<boolean>(false);

  const resetPassword: SubmitHandler<CreateNewPasswordFormData> = async ({
    password,
    confirmPassword,
  }) => {
    try {
      setLoading(true);
      const res = await Server.call(
        packageName,
        'resetPassword',
        password,
        confirmPassword,
        token
      );
      if (res.auth && onPasswordIsReset) {
        auth.updateAuth({
          auth: res.auth,
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
        });
        onPasswordIsReset();
      }
    } catch (error) {
      console.error('Error resetting password:', error);
      await Dialog.alert({
        title: 'Something went wrong',
        message:
          'Failed to reset password. Please try again or contact support.',
      });
    } finally {
      setLoading(false);
    }
  };

  restProps = useStyles(restProps, style.root);

  // disable button if any error or password not matches or fields are empty
  const password = watch('password');
  const confirmPassword = watch('confirmPassword');
  const isDisabled =
    !!errors.password ||
    !!errors.confirmPassword ||
    !password ||
    !confirmPassword ||
    confirmPassword !== password ||
    loading;

  return (
    <div {...restProps}>
      <form>
        <h2>Set A New Password</h2>
        <div className={style.FormGroup}>
          <Input
            type={'password'}
            placeholder="Enter new password"
            {...register('password', {
              required: true,
              minLength: 6,
            })}
          />
          {errors?.password?.type === 'required' && (
            <p className={style.ErrorMessage}>Password is required</p>
          )}
          {errors?.password?.type === 'minLength' && (
            <p className={style.ErrorMessage}>
              Password cannot less than 6 characters
            </p>
          )}

          <Input
            type={'password'}
            placeholder="Confirm your password"
            {...register('confirmPassword', {
              required: true,
            })}
          />
          {errors?.confirmPassword && (
            <p className={style.ErrorMessage}>Confirm password is required</p>
          )}
          {confirmPassword !== password && confirmPassword ? (
            <p className={style.ErrorMessage}>Password did not match</p>
          ) : null}
        </div>
        <Button
          color="primary"
          className={style.FormButton}
          disabled={isDisabled}
          onClick={handleSubmit(resetPassword)}
        >
          {loading ? 'Saving...' : 'Save'}
        </Button>
      </form>
    </div>
  );
}

export default CreateNewPasswordForm;
