/**
 * The app's Solid-OIDC Client ID Document and the sign-in theme extension it carries
 * (arch-08 §Branding: the Client ID Document).
 *
 * The theme is defined here once: its types, its JSON Schema, the font allow-list and
 * `validateClientTheme`. webid.email imports this module to read the themes of the documents it
 * fetches, so it stays free of Express and Node built-ins.
 */

/** The one key the theme extension sits under. Other issuers ignore it. */
export const SIGNIN_THEME_KEY = 'https://linked.cm/ns/signin#theme';

/** Where the document is served, under `SITE_ROOT`. Its full URL is the `client_id`. */
export const CLIENT_ID_DOCUMENT_PATH = '/.well-known/linked-client.jsonld';

/** The redirect URI every web client lists, under `SITE_ROOT`. */
export const OIDC_CALLBACK_PATH = '/auth/oidc/callback';

/** The JSON-LD context of a Solid-OIDC Client ID Document. */
export const SOLID_OIDC_CONTEXT = 'https://www.w3.org/ns/solid/oidc-context.jsonld';

/**
 * The fonts a theme may name. The issuer hosts these itself, so a theme never loads a font from
 * elsewhere. `system-ui` is the platform's own font.
 */
export const SIGNIN_THEME_FONTS = Object.freeze([
  'system-ui',
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Source Sans 3',
  'Nunito',
  'Poppins',
  'Work Sans',
  'Merriweather',
  'Lora',
  'Playfair Display',
] as const);

export type SigninThemeFont = (typeof SIGNIN_THEME_FONTS)[number];

export const SIGNIN_THEME_LAYOUTS = Object.freeze(['card', 'two-column'] as const);
export const SIGNIN_THEME_SCHEMES = Object.freeze(['light', 'dark'] as const);
export const SIGNIN_THEME_COLORS = Object.freeze([
  'primary',
  'accent',
  'background',
  'panel',
  'text',
] as const);

const BRAND_NAME_MAX_LENGTH = 80;

/** How the issuer should style its sign-in page for this app. Every field is optional. */
export interface SigninTheme {
  /** A centred card, or two columns with a decorative side panel. */
  layout?: (typeof SIGNIN_THEME_LAYOUTS)[number];
  /** Plain CSS colours: hex, `rgb()`/`hsl()` with numbers, or a named colour. */
  colors?: Partial<Record<(typeof SIGNIN_THEME_COLORS)[number], string>>;
  font?: SigninThemeFont;
  scheme?: (typeof SIGNIN_THEME_SCHEMES)[number];
  brand?: {
    name?: string;
    /** `https:` (or `http:` on localhost). */
    logoUri?: string;
  };
  /**
   * An image or animated SVG for the side panel, `https:` (or `http:` on localhost). The issuer
   * renders it as an `<img>` and enforces its size limits.
   */
  panelArt?: string;
}

/** A theme value `validateClientTheme` dropped. */
export interface ThemeProblem {
  /** Where the value was, e.g. `colors.primary`; `''` for the theme itself. */
  path: string;
  value: unknown;
  reason: string;
}

/** What an app configures to serve its Client ID Document (`Auth.signinClient`). */
export interface SigninClientConfig {
  /** The app's name, as the issuer shows it ("Sign in to …"). */
  clientName: string;
  logoUri?: string;
  /** The app's home page; defaults to `SITE_ROOT`. */
  clientUri?: string;
  policyUri?: string;
  tosUri?: string;
  /**
   * Redirect URIs besides `{SITE_ROOT}/auth/oidc/callback`, e.g. app-claimed links of native
   * builds. A custom scheme is allowed; `http:` only on localhost.
   */
  redirectUris?: string[];
  theme?: SigninTheme;
}

export interface ClientIdDocument {
  '@context': string[];
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  client_uri: string;
  logo_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  grant_types: string[];
  response_types: string[];
  scope: string;
  token_endpoint_auth_method: string;
  [SIGNIN_THEME_KEY]?: SigninTheme;
}

// The CSS named colours (CSS Color 4) plus `transparent`. `currentcolor` and system colours are
// left out: they depend on the page, not the theme.
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen transparent'
  ).split(' ')
);

// Hex, or rgb()/rgba()/hsl()/hsla() whose arguments are numbers (with %, deg or none), separated
// by commas, spaces or a slash. Nothing else gets through: no url(), var(), calc() or escapes.
const HEX_COLOR = '#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})';
const NUMBER_ARG = '-?(?:\\d+\\.?\\d*|\\.\\d+)(?:%|deg)?';
const ARG_SEPARATOR = '(?:\\s*[,/]\\s*|\\s+)';
const FUNCTION_COLOR = `(?:rgba?|hsla?)\\(\\s*${NUMBER_ARG}(?:${ARG_SEPARATOR}${NUMBER_ARG}){2,3}\\s*\\)`;
const COLOR_PATTERN = `^(?:${HEX_COLOR}|${FUNCTION_COLOR})$`;
const COLOR_REGEX = new RegExp(COLOR_PATTERN);

/**
 * Whether `value` is a colour a theme may use: hex, numeric `rgb()`/`hsl()`, or a named colour in
 * lowercase (as the JSON Schema lists them).
 */
export const isThemeColor = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 64 &&
  (COLOR_REGEX.test(value) || NAMED_COLORS.has(value));

const isLocalhost = (url: URL) => url.hostname === 'localhost';

// Characters a URL parser would quietly encode or strip, and that could break out of an attribute
// or a CSS value on the page the URL ends up in. A URL containing one is refused, not rewritten.
const UNSAFE_URL_CHARACTERS = /[\s"'<>()\\`]/;

/**
 * `https:`, or `http:` on localhost: what an issuer accepts for the document's own URLs. Also
 * refuses whitespace, quotes, angle brackets, parentheses, backticks and backslashes anywhere in it.
 */
export const isAllowedWebUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || UNSAFE_URL_CHARACTERS.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalhost(url));
};

/**
 * The JSON Schema of the theme extension (draft 2020-12), for tools that validate with a schema.
 * `validateClientTheme` applies the same rules and is what the issuer uses; it also checks that a
 * URL is `https:` or a localhost `http:` and that a named colour is one CSS knows, which a schema
 * pattern cannot say exactly.
 */
export const SIGNIN_THEME_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://linked.cm/ns/signin/theme',
  title: 'Sign-in theme',
  type: 'object',
  additionalProperties: false,
  properties: {
    layout: { enum: [...SIGNIN_THEME_LAYOUTS] },
    colors: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        SIGNIN_THEME_COLORS.map((name) => [name, { $ref: '#/$defs/color' }])
      ),
    },
    font: { enum: [...SIGNIN_THEME_FONTS] },
    scheme: { enum: [...SIGNIN_THEME_SCHEMES] },
    brand: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', pattern: '\\S', maxLength: BRAND_NAME_MAX_LENGTH },
        logoUri: { $ref: '#/$defs/webUrl' },
      },
    },
    panelArt: { $ref: '#/$defs/webUrl' },
  },
  $defs: {
    color: {
      anyOf: [
        { type: 'string', maxLength: 64, pattern: COLOR_PATTERN },
        { enum: [...NAMED_COLORS] },
      ],
    },
    webUrl: {
      type: 'string',
      format: 'uri',
      pattern: '^(https://|http://localhost(:[0-9]+)?(/|$))[^\\s"\'<>()\\\\`]*$',
    },
  },
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);

const THEME_KEYS = ['layout', 'colors', 'font', 'scheme', 'brand', 'panelArt'];
const BRAND_KEYS = ['name', 'logoUri'];

/**
 * Reads the theme of a Client ID Document and keeps only its valid values.
 *
 * Every value that breaks the rules is dropped and listed in `problems` with its path and why:
 * a layout, scheme or font outside its list, a colour that is not a plain CSS colour (so no
 * `url(` or `var(`), a logo or panel art URL that is not `https:` (or localhost `http:`), a brand
 * name that is empty or too long, and any key the schema does not know. Never throws: it is fed
 * documents fetched from anywhere. `theme` is `undefined` when the document has no theme or
 * nothing in it was valid.
 */
export const validateClientTheme = (
  doc: unknown
): { theme: SigninTheme | undefined; problems: ThemeProblem[] } => {
  const problems: ThemeProblem[] = [];
  const drop = (path: string, value: unknown, reason: string) =>
    problems.push({ path, value, reason });

  if (!isPlainObject(doc) || !(SIGNIN_THEME_KEY in doc)) return { theme: undefined, problems };
  const raw = doc[SIGNIN_THEME_KEY];
  if (!isPlainObject(raw)) {
    drop('', raw, 'the theme must be an object');
    return { theme: undefined, problems };
  }

  const theme: SigninTheme = {};
  for (const key of Object.keys(raw)) {
    if (!THEME_KEYS.includes(key)) drop(key, raw[key], 'unknown theme field');
  }

  if ('layout' in raw) {
    if (oneOf(SIGNIN_THEME_LAYOUTS, raw.layout)) theme.layout = raw.layout;
    else drop('layout', raw.layout, `must be one of ${SIGNIN_THEME_LAYOUTS.join(', ')}`);
  }
  if ('scheme' in raw) {
    if (oneOf(SIGNIN_THEME_SCHEMES, raw.scheme)) theme.scheme = raw.scheme;
    else drop('scheme', raw.scheme, `must be one of ${SIGNIN_THEME_SCHEMES.join(', ')}`);
  }
  if ('font' in raw) {
    if (oneOf(SIGNIN_THEME_FONTS, raw.font)) theme.font = raw.font;
    else drop('font', raw.font, 'not in the font allow-list');
  }

  if ('colors' in raw) {
    if (!isPlainObject(raw.colors)) {
      drop('colors', raw.colors, 'must be an object');
    } else {
      const colors: SigninTheme['colors'] = {};
      for (const [name, value] of Object.entries(raw.colors)) {
        if (!oneOf(SIGNIN_THEME_COLORS, name)) drop(`colors.${name}`, value, 'unknown colour');
        else if (isThemeColor(value)) colors[name] = value;
        else drop(`colors.${name}`, value, 'not a plain CSS colour');
      }
      if (Object.keys(colors).length) theme.colors = colors;
    }
  }

  if ('brand' in raw) {
    if (!isPlainObject(raw.brand)) {
      drop('brand', raw.brand, 'must be an object');
    } else {
      const brand: NonNullable<SigninTheme['brand']> = {};
      const { name, logoUri } = raw.brand;
      for (const key of Object.keys(raw.brand)) {
        if (!BRAND_KEYS.includes(key)) drop(`brand.${key}`, raw.brand[key], 'unknown brand field');
      }
      if ('name' in raw.brand) {
        if (
          typeof name === 'string' &&
          name.trim() &&
          name.trim().length <= BRAND_NAME_MAX_LENGTH
        ) {
          brand.name = name.trim();
        } else {
          drop('brand.name', name, `must be text of 1 to ${BRAND_NAME_MAX_LENGTH} characters`);
        }
      }
      if ('logoUri' in raw.brand) {
        if (isAllowedWebUrl(logoUri)) brand.logoUri = new URL(logoUri).href;
        else drop('brand.logoUri', logoUri, 'must be an https: URL (http: only on localhost)');
      }
      if (Object.keys(brand).length) theme.brand = brand;
    }
  }

  if ('panelArt' in raw) {
    if (isAllowedWebUrl(raw.panelArt)) theme.panelArt = new URL(raw.panelArt).href;
    else drop('panelArt', raw.panelArt, 'must be an https: URL (http: only on localhost)');
  }

  return { theme: Object.keys(theme).length ? theme : undefined, problems };
};

// Schemes an app-claimed redirect link can never use: they run code or read local data.
const UNSAFE_REDIRECT_SCHEMES = ['javascript:', 'data:', 'file:', 'blob:', 'vbscript:'];

/**
 * Builds the app's Client ID Document from its configuration and `SITE_ROOT`.
 *
 * `siteRoot` loses one trailing slash, so the document never advertises `//.well-known/…`. The
 * configured theme goes through `validateClientTheme`; invalid values are left out and returned
 * in `problems` for the caller to log. Throws when `siteRoot` or a configured URL would make the
 * issuer reject the document: `http:` is allowed only on localhost.
 */
export const buildClientIdDocument = (
  config: SigninClientConfig,
  siteRoot: string
): { document: ClientIdDocument; problems: ThemeProblem[] } => {
  const root = typeof siteRoot === 'string' ? siteRoot.replace(/\/$/, '') : '';
  if (!isAllowedWebUrl(root) || new URL(root).search || new URL(root).hash) {
    throw new Error(
      `Client ID Document: SITE_ROOT must be an https: URL (http: only on localhost) without a query or fragment, got ${JSON.stringify(siteRoot)}`
    );
  }
  const clientName = typeof config?.clientName === 'string' ? config.clientName.trim() : '';
  if (!clientName) {
    throw new Error('Client ID Document: clientName must be a non-empty string');
  }
  for (const field of ['logoUri', 'clientUri', 'policyUri', 'tosUri'] as const) {
    const value = config[field];
    if (value !== undefined && !isAllowedWebUrl(value)) {
      throw new Error(
        `Client ID Document: ${field} must be an https: URL (http: only on localhost), got ${JSON.stringify(value)}`
      );
    }
  }
  for (const uri of config.redirectUris ?? []) {
    let url: URL | undefined;
    try {
      url = new URL(uri);
    } catch {
      url = undefined;
    }
    if (
      !url ||
      UNSAFE_URL_CHARACTERS.test(uri) ||
      UNSAFE_REDIRECT_SCHEMES.includes(url.protocol) ||
      (url.protocol === 'http:' && !isLocalhost(url))
    ) {
      throw new Error(
        `Client ID Document: redirect URI ${JSON.stringify(uri)} must be a URL, http: only on localhost, and not ${UNSAFE_REDIRECT_SCHEMES.join(' ')}`
      );
    }
  }

  const document: ClientIdDocument = {
    '@context': [SOLID_OIDC_CONTEXT],
    client_id: `${root}${CLIENT_ID_DOCUMENT_PATH}`,
    client_name: clientName,
    redirect_uris: [`${root}${OIDC_CALLBACK_PATH}`, ...(config.redirectUris ?? [])],
    client_uri: config.clientUri ?? root,
    ...(config.logoUri ? { logo_uri: config.logoUri } : {}),
    ...(config.policyUri ? { policy_uri: config.policyUri } : {}),
    ...(config.tosUri ? { tos_uri: config.tosUri } : {}),
    // A public client: code flow with PKCE, no client secret. The relying party keeps none of the
    // issuer's tokens, so no refresh_token grant.
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid webid email',
    token_endpoint_auth_method: 'none',
  };

  let problems: ThemeProblem[] = [];
  if (config.theme !== undefined) {
    const validated = validateClientTheme({ [SIGNIN_THEME_KEY]: config.theme });
    problems = validated.problems;
    if (validated.theme) document[SIGNIN_THEME_KEY] = validated.theme;
  }
  return { document, problems };
};
