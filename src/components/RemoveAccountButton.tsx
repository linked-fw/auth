import React, { useId, useState } from 'react';
import { Button } from '@_linked/primitives/components/Button';
import { ConfirmDialog } from '@_linked/primitives/components/ConfirmDialog';
import { Input } from '@_linked/primitives/components/Input';
import { Label } from '@_linked/primitives/components/Label';
import { useAuth } from '../hooks/useAuth.js';
import type {
  ReauthenticationMethod,
  RemoveAccountProof,
  RemoveAccountResult,
} from '../types/auth.js';
import { useTranslate } from '@tolgee/react';
import style from './RemoveAccountButton.module.css';

type OAuthProofProvider = 'google' | 'apple';

interface RemoveAccountButtonProps {
  confirmationText?: string;
  agreeText?: string;
  className?: string;
  /**
   * Run the provider's sign-in (popup / native) and resolve to what `signinOAuth` takes as its
   * second argument. Needed only for accounts without a password that use Google/Apple.
   */
  getOAuthSource?: (provider: OAuthProofProvider) => Promise<unknown>;
}

const PROVIDER_LABELS: Record<OAuthProofProvider, string> = {
  google: 'Google',
  apple: 'Apple',
};

export const RemoveAccountButton = ({
  confirmationText,
  agreeText,
  className,
  getOAuthSource,
  ...restProps
}: RemoveAccountButtonProps) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  // what the server will ask this account to confirm with; [] = the session is enough
  const [methods, setMethods] = useState<ReauthenticationMethod[]>([]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isOpening, setIsOpening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const auth = useAuth();
  const { t } = useTranslate();
  const prefix = 'removeAccount';
  const passwordId = useId();

  const needsPassword = methods.includes('password');
  const oauthMethods = methods.filter(
    (m): m is OAuthProofProvider => m === 'google' || m === 'apple'
  );
  // Without a password, the provider buttons are the confirmation.
  const confirmDisabled = needsPassword ? !password : oauthMethods.length > 0;

  const openDialog = async () => {
    setIsOpening(true);
    setPassword('');
    setError('');
    try {
      const result = await auth.getReauthenticationMethods();
      setMethods(result.methods);
    } catch (err) {
      // Open anyway: a delete without proof gets the methods back from the server.
      console.warn('@_linked/auth: could not load the reauthentication methods', err);
      setMethods([]);
    } finally {
      setIsOpening(false);
    }
    setIsModalOpen(true);
  };

  const handleResult = (res: RemoveAccountResult, proofSent: boolean) => {
    if (res === true) {
      setIsModalOpen(false);
      auth.signout();
      //hard refresh to the user from local memory
      window.location.href = '/';
      return;
    }
    if (res?.action === 'reauthenticate') {
      setMethods(res.methods);
      // the dialog stays open: the user can correct the password or pick another provider
      setError(
        proofSent
          ? t(prefix + '.wrongProof', 'That confirmation did not match this account.')
          : res.error
      );
      return;
    }
    setError(
      res?.error || t(prefix + '.deleteFailed', "Couldn't delete your account. Please try again.")
    );
  };

  const remove = async (proof?: RemoveAccountProof) => {
    setIsLoading(true);
    setError('');
    try {
      handleResult(await auth.removeAccount(proof), proof !== undefined);
    } catch (err) {
      console.warn('@_linked/auth: could not delete the account', err);
      setError(t(prefix + '.deleteFailed', "Couldn't delete your account. Please try again."));
    } finally {
      setIsLoading(false);
    }
  };

  const onRemoveAccount = () => {
    if (needsPassword) {
      if (password) remove({ password });
      return;
    }
    if (oauthMethods.length === 0) remove();
  };

  const confirmWithProvider = async (provider: OAuthProofProvider) => {
    if (!getOAuthSource) return;
    setIsLoading(true);
    setError('');
    let source: unknown;
    try {
      source = await getOAuthSource(provider);
    } catch (err) {
      // the user closed the provider's popup, or its sign-in failed: nothing was deleted
      console.warn('@_linked/auth: the provider sign-in did not complete', err);
      setIsLoading(false);
      return;
    }
    if (!source) {
      setIsLoading(false);
      return;
    }
    await remove({ provider, source });
  };

  const confirmation =
    confirmationText ||
    t(
      prefix + '.deleteConfirmation',
      'Are you sure you want to delete this account? Deleting your account will delete all personal information and all data related to you. You will not be able to undo this action'
    );

  const hasProof = needsPassword || oauthMethods.length > 0 || Boolean(error);
  const message = hasProof ? (
    <>
      <p>{confirmation}</p>
      <div className={style.Proof}>
        {needsPassword && (
          <div className={style.Field}>
            <Label htmlFor={passwordId}>
              {t(prefix + '.passwordLabel', 'Enter your password to confirm')}
            </Label>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={isLoading}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onRemoveAccount();
                }
              }}
            />
          </div>
        )}
        {!needsPassword && oauthMethods.length > 0 && (
          <div className={style.ProviderButtons}>
            {oauthMethods.map((provider) => (
              <Button
                key={provider}
                variant="outline"
                disabled={isLoading || !getOAuthSource}
                onClick={() => confirmWithProvider(provider)}
              >
                {t(prefix + '.confirmWithProvider', 'Confirm with {provider}', {
                  provider: PROVIDER_LABELS[provider],
                })}
              </Button>
            ))}
          </div>
        )}
        {!needsPassword && oauthMethods.length > 0 && !getOAuthSource && (
          <p className={style.Hint}>
            {t(
              prefix + '.noOAuthSource',
              'This account can only be confirmed with its sign-in provider, which this app does not offer here. Please contact support to delete it.'
            )}
          </p>
        )}
        {error && (
          <p className={style.ErrorMessage} role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  ) : (
    confirmation
  );

  return (
    <div {...restProps}>
      <Button
        className={className}
        variant="outline"
        disabled={isOpening}
        onClick={openDialog}
      >
        {t(prefix + '.deleteProfileButton', 'Delete Profile')}
      </Button>
      {/* `alertdialog` rather than a dialog: deleting an account is not dismissable by
          clicking the backdrop, and `tone="danger"` states the consequence rather than
          picking a colour. */}
      <ConfirmDialog
        open={isModalOpen}
        onOpenChange={(open) => {
          if (!isLoading) setIsModalOpen(open);
        }}
        onConfirm={onRemoveAccount}
        tone="danger"
        isLoading={isLoading}
        confirmDisabled={confirmDisabled}
        title={t(prefix + '.deleteTitle', 'Delete your account?')}
        message={message}
        confirmText={agreeText || t(prefix + '.yes', 'Yes, delete my account')}
        cancelText={t(prefix + '.cancel', 'Cancel')}
      />
    </div>
  );
};

//register all components in this file
// registerPackageModule({ RemoveAccountButton });
