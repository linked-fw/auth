import { ReactElement, useEffect } from 'react';
import { useAuth, useAuthRenderLoading } from '../hooks/useAuth.js';
import { useNavigate } from 'react-router-dom';

interface RequireAuthProps {
  children: ReactElement;
  signinRoute?: string;
  /** Shown while the session is validated. Defaults to `ProvideAuth`'s, then to nothing. */
  renderLoading?: () => ReactElement;
}

export const RequireAuth = ({
  children,
  signinRoute,
  renderLoading,
}: RequireAuthProps) => {
  const auth = useAuth();
  const navigate = useNavigate();
  const defaultRenderLoading = useAuthRenderLoading();

  // Also re-run when validation ends: on a full page load `validating` starts true, so a visitor
  // without a session only becomes "signed out" when it flips to false, with userAccount unchanged.
  useEffect(() => {
    if (!auth.userAccount && !auth.validating) {
      navigate(signinRoute || '/signin');
    }
  }, [auth.userAccount, auth.validating, navigate, signinRoute]);

  // If the user is not logged in and we are still validating, we can show a loading state
  if (!auth.userAccount && auth.validating) {
    const render = renderLoading ?? defaultRenderLoading;
    return render ? render() : null;
  }
  // If the user is logged in, we render the children components
  //Note: components wrapped in RequireAuth will never render on the first request, this is to match the server side
  //where login will always be false
  return auth.userAccount ? children : null;
};
