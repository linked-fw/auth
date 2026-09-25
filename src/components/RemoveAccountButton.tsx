import React, { useState } from 'react';
import { Button } from '@_linked/primitives/components/Button';
import { ConfirmDialog } from '@_linked/primitives/components/ConfirmDialog';
import { useAuth } from '../hooks/useAuth.js';
import { useTranslate } from '@tolgee/react';

interface RemoveAccountButtonProps {
  confirmationText?: string;
  agreeText?: string;
  className;
}

export const RemoveAccountButton = ({
  confirmationText,
  agreeText,
  className,
  ...restProps
}: RemoveAccountButtonProps) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const auth = useAuth();
  const { t } = useTranslate();
  const prefix = 'removeAccount';

  const onRemoveAccount = async () => {
    setIsModalOpen(false);
    auth.removeAccount().then((res) => {
      if (res) {
        auth.signout();
        //hard refresh to the user from local memory
        window.location.href = '/';
      }
    });
  };

  return (
    <div {...restProps}>
      <Button
        className={className}
        variant="outline"
        onClick={() => setIsModalOpen(true)}
      >
        {t(prefix + '.deleteProfileButton', 'Delete Profile')}
      </Button>
      {/* `alertdialog` rather than a dialog: deleting an account is not dismissable by
          clicking the backdrop, and `tone="danger"` states the consequence rather than
          picking a colour. */}
      <ConfirmDialog
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        onConfirm={onRemoveAccount}
        tone="danger"
        title={t(prefix + '.deleteTitle', 'Delete your account?')}
        message={
          confirmationText ||
          t(
            prefix + '.deleteConfirmation',
            'Are you sure you want to delete this account? Deleting your account will delete all personal information and all data related to you. You will not be able to undo this action'
          )
        }
        confirmText={agreeText || t(prefix + '.yes', 'Yes, delete my account')}
        cancelText={t(prefix + '.cancel', 'Cancel')}
      />
    </div>
  );
};

//register all components in this file
// registerPackageModule({ RemoveAccountButton });
