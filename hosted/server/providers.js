// @ts-check
// The OAuth provider allowlist, shared by the Worker, the frontend bundle, and
// the plain-node deploy scripts. Plain JavaScript with no imports so `node` can
// load it directly; tsconfig's allowJs gives TypeScript the JSDoc types, and the
// pragma checks them here, which project-wide checkJs would not do safely.

export const providerIds = /** @type {const} */ ([
  "github",
  "google",
  "microsoft",
  "apple",
]);

/** @typedef {(typeof providerIds)[number]} ProviderId */

/** @type {Record<ProviderId, string>} */
export const providerNames = {
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
  apple: "Apple",
};

// Origin each provider's authorization request must be redirected to.
/** @type {Record<ProviderId, string>} */
export const providerAuthorizationOrigins = {
  github: "https://github.com",
  google: "https://accounts.google.com",
  microsoft: "https://login.microsoftonline.com",
  apple: "https://appleid.apple.com",
};
