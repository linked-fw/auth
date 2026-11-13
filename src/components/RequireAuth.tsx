import { ReactElement, useEffect } from 'react';
import { useAuth, useAuthRenderLoading } from '../hooks/useAuth.js';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * The sign-in URL for a visitor sent away from `from` (path, query and hash of the guarded page):
 * `signinRoute` with `from=<from>` added to its query, so the sign-in page can return the visitor
 * there. A `from` already in `signinRoute` is replaced.
 */
export function signinUrlFrom(signinRoute: string, from: string): string {
  const hashAt = signinRoute.indexOf('#');
  const beforeHash = hashAt === -1 ? signinRoute : signinRoute.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : signinRoute.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? '' : beforeHash.slice(queryAt + 1));
  params.set('from', from);
  return `${path}?${params.toString()}${hash}`;
}

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
  const location = useLocation();
  const defaultRenderLoading = useAuthRenderLoading();

  // Also re-run when validation ends: on a full page load `validating` starts true, so a visitor
  // without a session only becomes "signed out" when it flips to false, with userAccount unchanged.
  // The guarded page goes along as `from`, so the sign-in page can bring the visitor back to it.
  const from = location.pathname + location.search + location.hash;
  useEffect(() => {
    if (!auth.userAccount && !auth.validating) {
      navigate(signinUrlFrom(signinRoute || '/signin', from));
    }
  }, [auth.userAccount, auth.validating, navigate, signinRoute, from]);

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
