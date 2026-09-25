import React, { useEffect, useState } from 'react';
import { Button } from '@_linked/primitives/components/Button';
import { Dialog } from '@_linked/primitives/components/Dialog';
import { VisuallyHidden } from '@_linked/primitives/components/VisuallyHidden';
import style from './EditPasswordButton.module.css';
import CreateNewPasswordForm from './CreateNewPasswordForm.js';
import { AuthCredential } from '../shapes/AuthCredential.js';

export function EditPasswordButton({
  onPasswordUpdated,
}: {
  onPasswordUpdated?: () => void;
}) {
  const [showModal, setShowModal] = useState<boolean>(false);

  const [hasPassword, sethasPassword] = useState<boolean>(false);
  const [updated, setUpdated] = useState<boolean>(false);

  useEffect(() => {
    AuthCredential.userHasAuthCredential().then((hasCredential) => {
      sethasPassword(hasCredential);
    });
  });

  const onEdited = () => {
    setShowModal(false);
    setUpdated(true);
    setTimeout(() => {
      setUpdated(false);
    }, 3000);
  };
  return (
    hasPassword && (
      <>
        <Button
          color={updated ? 'tertiary' : 'primary'}
          variant={'outline'}
          className={style.FormButton}
          onClick={() => setShowModal(true)}
        >
          {updated ? '✔ Password updated' : 'Change Password'}
        </Button>
        <Dialog.Root open={showModal} onOpenChange={setShowModal}>
          {/* The visible heading belongs to the form, which is also rendered outside a
              dialog. Radix still requires a title for `aria-labelledby`, so it is supplied
              here and hidden rather than duplicated on screen. */}
          <Dialog.Content className={style.modal} aria-describedby={undefined}>
            <VisuallyHidden>
              <Dialog.Title>Change Password</Dialog.Title>
            </VisuallyHidden>
            <CreateNewPasswordForm
              onPasswordIsReset={onEdited}
              className={style.modalForm}
            />
          </Dialog.Content>
        </Dialog.Root>
      </>
    )
  );
}
