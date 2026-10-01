// Synced from pgstencil test fixtures for provider protocol parity.
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import type { OAuthFetch } from "@pgstencil/auth/oauth-providers";
import type {
  Provider,
  OAuthSettings,
} from "@pgstencil/auth/better-auth-oauth";

export const allOAuthCredentials = {
  google: {
    clientId: "test-google-client",
    clientSecret: "test-google-secret",
  },
  apple: { clientId: "test-apple-client", clientSecret: "test-apple-secret" },
  facebook: {
    clientId: "test-facebook-client",
    clientSecret: "test-facebook-secret",
  },
  github: {
    clientId: "test-github-client",
    clientSecret: "test-github-secret",
  },
} satisfies OAuthSettings;
export const microsoftTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
export const betterAuthCredentials = {
  ...allOAuthCredentials,
  microsoft: {
    clientId: "test-microsoft-client",
    clientSecret: "test-microsoft-secret",
  },
} satisfies OAuthSettings;
export const oauthCredentials = {
  google: allOAuthCredentials.google,
  github: allOAuthCredentials.github,
};
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
// Only the badSignature grant needs a second key; generating it is ~40ms.
let wrongKey: typeof key | undefined;
const otherKey = () =>
  (wrongKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }));
const jwk = {
  ...key.publicKey.export({ format: "jwk" }),
  kid: "test-key",
  use: "sig",
  alg: "RS256",
};
export const endpointPaths: Record<string, string> = {
  "https://login.microsoftonline.com/common/oauth2/v2.0/token":
    "/microsoft/token",
  "https://login.microsoftonline.com/common/discovery/v2.0/keys": "/keys",
  "https://appleid.apple.com/.well-known/openid-configuration":
    "/apple/discovery",
  "https://appleid.apple.com/auth/token": "/apple/token",
  "https://appleid.apple.com/auth/keys": "/keys",
  "https://graph.facebook.com/oauth/access_token": "/facebook/token",
  "https://graph.facebook.com/me": "/facebook/user",
  "https://graph.facebook.com/debug_token": "/facebook/debug",
  "https://graph.facebook.com/v24.0/oauth/access_token": "/facebook/token",
  "https://accounts.google.com/.well-known/openid-configuration": "/discovery",
  "https://oauth2.googleapis.com/token": "/google/token",
  "https://www.googleapis.com/oauth2/v3/certs": "/keys",
  "https://github.com/login/oauth/access_token": "/github/token",
  "https://api.github.com/user": "/user",
  "https://api.github.com/user/emails": "/emails",
};
export interface GrantOptions {
  subject?: string;
  email?: string;
  verified?: boolean;
  claims?: Record<string, unknown>;
  badSignature?: boolean;
  missingIdToken?: boolean;
  tokenFailure?: boolean;
  profileFailure?: boolean;
  githubEmails?: unknown;
}
interface Grant {
  provider: Provider;
  authorization: URL;
  options: GrantOptions;
}

/** Real local HTTP endpoints, with test-only signing keys and dummy OAuth clients. */
export async function mockOAuthServer(
  settings: { betterAuth?: boolean; now?: () => Date } = {},
) {
  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, Grant>();
  const requests: {
    url: string;
    method: string;
    body: string;
    headers: Record<string, string>;
  }[] = [];
  let sequence = 0;
  let discoveryFailure = false;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, "http://mock.test");
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname.endsWith("/discovery")) {
        if (discoveryFailure) return json({ error: "unavailable" }, 503);
        const apple = url.pathname.startsWith("/apple");
        return json({
          issuer: apple
            ? "https://appleid.apple.com"
            : "https://accounts.google.com",
          authorization_endpoint: apple
            ? "https://appleid.apple.com/auth/authorize"
            : "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: apple
            ? "https://appleid.apple.com/auth/token"
            : "https://oauth2.googleapis.com/token",
          jwks_uri: apple
            ? "https://appleid.apple.com/auth/keys"
            : "https://www.googleapis.com/oauth2/v3/certs",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          ...(apple ? {} : { code_challenge_methods_supported: ["S256"] }),
        });
      }
      if (url.pathname === "/keys") return json({ keys: [jwk] });
      if (url.pathname.endsWith("/token")) {
        const form = new URLSearchParams(body);
        const code = form.get("code") ?? "";
        const grant = grants.get(code);
        grants.delete(code);
        if (!grant) return json({ error: "invalid_grant" }, 400);
        const credentials = betterAuthCredentials[grant.provider];
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          req.method !== "POST" ||
          url.pathname !== `/${grant.provider}/token` ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_id") !== credentials.clientId ||
          form.get("client_secret") !== credentials.clientSecret ||
          form.get("redirect_uri") !==
            grant.authorization.searchParams.get("redirect_uri") ||
          (settings.betterAuth
            ? grant.authorization.searchParams.has("code_challenge") &&
              challenge !==
                grant.authorization.searchParams.get("code_challenge")
            : grant.provider === "google" || grant.provider === "github"
              ? challenge !==
                grant.authorization.searchParams.get("code_challenge")
              : form.has("code_verifier")) ||
          grant.options.tokenFailure
        )
          return json(
            {
              error: "invalid_grant",
              error_description: "synthetic-secret-never-render-this",
            },
            400,
          );
        const accessToken = `mock-access-${code}`;
        accessTokens.set(accessToken, grant);
        const response: Record<string, unknown> = {
          access_token: accessToken,
          token_type: "Bearer",
          scope:
            grant.provider === "google"
              ? "openid email"
              : "read:user,user:email",
        };
        if (
          ["google", "apple", "microsoft"].includes(grant.provider) &&
          !grant.options.missingIdToken
        ) {
          const now = Math.floor(
            (settings.now?.().getTime() ?? Date.now()) / 1000,
          ); // Upstream protocol clock, independent of application DevTime.
          const claims = {
            iss:
              grant.provider === "apple"
                ? "https://appleid.apple.com"
                : "https://accounts.google.com",
            aud: credentials.clientId,
            sub: grant.options.subject ?? `${grant.provider}-person-1`,
            email: grant.options.email ?? "oauth@example.test",
            email_verified: grant.options.verified ?? true,
            nonce: grant.authorization.searchParams.get("nonce"),
            iat: now,
            exp: now + 3600,
            ...(grant.provider === "microsoft"
              ? {
                  iss: `https://login.microsoftonline.com/${microsoftTenant}/v2.0`,
                  tid: microsoftTenant,
                  oid:
                    grant.options.subject ??
                    "11111111-1111-4111-8111-111111111111",
                  name: "Mock Microsoft",
                  // Real Microsoft tokens typically use optional xms_edov, not email_verified.
                  email_verified: undefined,
                  xms_edov: grant.options.verified ?? true,
                }
              : {}),
            ...grant.options.claims,
          };
          const unsigned = [
            Buffer.from(
              JSON.stringify({ alg: "RS256", kid: "test-key" }),
            ).toString("base64url"),
            Buffer.from(JSON.stringify(claims)).toString("base64url"),
          ].join(".");
          response.id_token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), grant.options.badSignature ? otherKey().privateKey : key.privateKey).toString("base64url")}`;
        }
        return json(response);
      }
      if (url.pathname === "/facebook/debug") {
        const grant = accessTokens.get(
          url.searchParams.get("input_token") ?? "",
        );
        const credentials = allOAuthCredentials.facebook;
        const valid =
          !!grant &&
          url.searchParams.get("access_token") ===
            `${credentials.clientId}|${credentials.clientSecret}`;
        return json({
          data: {
            is_valid: valid,
            app_id: credentials.clientId,
            user_id: grant?.options.subject ?? "12345",
          },
        });
      }
      const accessToken =
        req.headers.authorization?.replace(/^Bearer /i, "") ?? "";
      const grant = accessTokens.get(accessToken);
      if (grant?.provider === "facebook" && url.pathname === "/facebook/user") {
        const expected = createHmac(
          "sha256",
          allOAuthCredentials.facebook.clientSecret,
        )
          .update(accessToken)
          .digest("hex");
        if (
          !settings.betterAuth &&
          (url.searchParams.get("appsecret_proof") !== expected ||
            url.searchParams.get("fields") !== "id,email")
        )
          return json({ error: "invalid_proof" }, 400);
        if (grant.options.profileFailure)
          return json({ error: "unavailable" }, 503);
        return json({
          id: grant.options.subject ?? "12345",
          ...(settings.betterAuth
            ? {
                name: "Mock Facebook",
                picture: { data: { url: "https://example.test/avatar" } },
              }
            : {}),
          email: grant.options.email ?? "oauth@example.test",
        });
      }
      if (!grant || grant.provider !== "github")
        return json({ error: "unauthorized" }, 401);
      if (grant.options.profileFailure)
        return json({ error: "unavailable" }, 503);
      if (url.pathname === "/user")
        return json({
          id: Number(grant.options.subject ?? "12345"),
          login: "changeable-handle",
          email: "untrusted-public@example.test",
        });
      if (url.pathname === "/emails") {
        const addresses = grant.options.githubEmails ?? [
          {
            email: grant.options.email ?? "oauth@example.test",
            primary: true,
            verified: grant.options.verified ?? true,
            visibility: "private",
          },
        ];
        const page = Number(url.searchParams.get("page") ?? 1);
        return json(
          Array.isArray(addresses)
            ? addresses.slice((page - 1) * 100, page * 100)
            : addresses,
        );
      }
      json({ error: "not_found" }, 404);
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing mock server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const transport: OAuthFetch = async (input, init) => {
    const url = new URL(input);
    const path = endpointPaths[url.origin + url.pathname];
    if (!path)
      throw new Error(
        `Unexpected OAuth network destination: ${url.origin}${url.pathname}`,
      );
    requests.push({
      url: url.href,
      method: init.method,
      headers: { ...init.headers },
      body: String(init.body ?? ""),
    });
    const { body, ...options } = init;
    return fetch(origin + path + url.search, {
      ...options,
      ...(body === undefined
        ? {}
        : {
            body:
              body instanceof Uint8Array ? new Uint8Array(body).buffer : body,
          }),
    });
  };
  return {
    transport,
    origin,
    requests,
    failDiscovery(value: boolean) {
      discoveryFailure = value;
    },
    authorize(
      provider: Provider,
      authorization: URL,
      options: GrantOptions = {},
    ): URL {
      const code = `code-${provider}-${++sequence}`;
      grants.set(code, { provider, authorization, options });
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state")!,
      );
      callback.searchParams.set("code", code);
      return callback;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
