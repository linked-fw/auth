import React from 'react';
import { useSearchParams } from 'react-router-dom';
import CreateNewPasswordForm from './CreateNewPasswordForm.js';
import style from './ForgotPasswordCallback.module.css';

export default function ForgotPasswordCallback({ onPasswordIsReset }) {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  // The full-viewport centring used to live on CreateNewPasswordForm's own `.root`
  // (`height: 100vh`), which broke that same form when EditPasswordButton renders it
  // inside a dialog. Page-level centring belongs to the page.
  return (
    <div className={style.Fallback}>
      <CreateNewPasswordForm
        token={token}
        onPasswordIsReset={onPasswordIsReset}
      />
    </div>
  );
}
