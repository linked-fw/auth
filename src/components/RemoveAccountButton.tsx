import React, { useState } from 'react';
import style from './RemoveAccountButton.module.css';
import { Modal } from 'lincd-mui-base/components/Modal';
import { Button } from 'lincd-mui-base/components/Button';
import { useAuth } from '../hooks/useAuth.js';
import { useTranslate } from '@_linked/translation/react';

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

  const onToggleModal = () => setIsModalOpen(!isModalOpen);

  const onRemoveAccount = async () => {
    onToggleModal();
    auth.removeAccount().then((res) => {
      if (res) {
        auth.signout();
        //hard refresh to the user from local memory
        window.location.href = '/';
      }
    });
  };
  // restProps = useStyles(restProps, style.root);
  return (
    <div {...restProps}>
      <Button className={className} variant="outlined" onClick={onToggleModal}>
        {t(prefix + '.deleteProfileButton', 'Delete Profile')}
      </Button>
      <Modal isOpen={isModalOpen} onClose={onToggleModal}>
        <div className={style.modal}>
          <p>
            {confirmationText ||
              t(
                prefix + '.deleteConfirmation',
                'Are you sure you want to delete this account? Deleting your account will delete all personal information and all data related to you. You will not be able to undo this action'
              )}
          </p>
          <div className={style.modalButtonContainer}>
            <Button color={'secondary'} onClick={onToggleModal}>
              {confirmationText || t(prefix + '.cancel', 'Cancel')}
            </Button>
            <Button onClick={onRemoveAccount}>
              {agreeText || t(prefix + '.yes', 'Yes, delete my account')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

//register all components in this file
// registerPackageModule({ RemoveAccountButton });
