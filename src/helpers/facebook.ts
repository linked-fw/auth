type FetchResponse = {
  ok: boolean;
  json: () => Promise<any>;
};

export type FacebookFetch = (
  input: string,
  init?: Record<string, any>
) => Promise<FetchResponse>;

export type FacebookValidationOptions = {
  appId?: string;
  appSecret?: string;
  fetch?: FacebookFetch;
};

export type VerifiedFacebookIdentity = {
  id: string;
  email: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  imageUrl?: string;
};

const FacebookHelper = {
  async validateAccessToken(
    accessToken: string,
    options: FacebookValidationOptions = {}
  ): Promise<VerifiedFacebookIdentity> {
    if (!accessToken) throw new Error('Facebook access token is required');

    const appId = options.appId || process.env.FACEBOOK_CLIENT_ID;
    const appSecret = options.appSecret || process.env.FACEBOOK_CLIENT_SECRET;
    if (!appId || !appSecret) {
      throw new Error('Facebook server credentials are not configured');
    }

    const fetcher = options.fetch || (globalThis.fetch as FacebookFetch);
    if (!fetcher) throw new Error('Facebook token validation is unavailable');

    const debugUrl =
      'https://graph.facebook.com/debug_token?' +
      new URLSearchParams({
        input_token: accessToken,
        access_token: `${appId}|${appSecret}`,
      }).toString();
    const debugResponse = await fetcher(debugUrl);
    const debugResult = await debugResponse.json();
    if (
      !debugResponse.ok ||
      !debugResult?.data?.is_valid ||
      debugResult.data.app_id !== appId
    ) {
      throw new Error('Facebook access token is invalid');
    }

    const profileUrl =
      'https://graph.facebook.com/me?' +
      new URLSearchParams({
        fields: 'id,email,name,first_name,last_name,picture',
        access_token: accessToken,
      }).toString();
    const profileResponse = await fetcher(profileUrl);
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile?.id || !profile?.email) {
      throw new Error('Facebook profile is invalid');
    }

    return {
      id: String(profile.id),
      email: String(profile.email),
      name: typeof profile.name === 'string' ? profile.name : undefined,
      givenName:
        typeof profile.first_name === 'string' ? profile.first_name : undefined,
      familyName:
        typeof profile.last_name === 'string' ? profile.last_name : undefined,
      imageUrl:
        typeof profile.picture?.data?.url === 'string'
          ? profile.picture.data.url
          : undefined,
    };
  },
};

export default FacebookHelper;
