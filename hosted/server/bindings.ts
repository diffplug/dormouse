import type { BetterAuthWorkerBindings } from "@pgstencil/auth/better-auth-workers";
import { exactOrigin } from "./headers";
import { providerBindings } from "./policy";
import type { RelayRoomRpc } from "./relay-room-contract";

// Each Worker's bindings mapper (`docs/specs/security-hosted.md` -> "Origin
// boundary"): the only bindings that reach its routes, whatever else the
// deployment carries. A mapper names what its Worker uses and nothing more, so
// a secret set on the wrong Worker, or left on a preview, stays unread.

/** Every Worker's: its own origin, which the 421 gate holds requests to. */
export interface WorkerEnv {
  APP_ORIGIN: string;
  BUILD_SHA?: string;
  /** Postgres, as the Worker's own role; `/api/ready` queries through it. */
  HYPERDRIVE?: { connectionString: string };
}

interface Assets {
  fetch(request: Request): Promise<Response>;
}

/** `hosted.dormouse.sh`: the account frontend, auth, and voice-token minting. */
export interface AccountEnv extends BetterAuthWorkerBindings, WorkerEnv {
  HYPERDRIVE: { connectionString: string };
  ASSETS: Assets;
  /** Enrollment approvals, per account. */
  RELAY_APPROVE_LIMIT: RateLimit;
  /** The relay Worker's `RelayRoom`s, which a Burrow's removal closes the socket of. */
  RELAY_ROOM: DurableObjectNamespace<RelayRoomRpc>;
  EMAIL_FROM: string;
  POSTMARK_SERVER_TOKEN: string;
  OAUTH_PROVIDERS?: string;
}

/** `relay.dormouse.sh`: the Hosted Relay and Pocket, the one-time rendezvous and its phone page. */
export interface RelayEnv extends WorkerEnv {
  ASSETS: Assets;
  HYPERDRIVE: { connectionString: string };
  ONE_TIME_ROOM: DurableObjectNamespace;
  /** One `RelayRoom` per account, holding its relay sockets. */
  RELAY_ROOM: DurableObjectNamespace<RelayRoomRpc>;
  ONE_TIME_MINT_LIMIT: RateLimit;
  ONE_TIME_JOIN_LIMIT: RateLimit;
  RELAY_SIGNIN_LIMIT: RateLimit;
  RELAY_SETUP_LIMIT: RateLimit;
  RELAY_ENROLL_BEGIN_LIMIT: RateLimit;
  RELAY_ENROLL_POLL_LIMIT: RateLimit;
  /**
   * The account Worker's origin, which a begin answer's `verificationUrl`
   * names: exactly an origin once mapped, or absent, and then it names none.
   */
  ACCOUNT_ORIGIN?: string;
  /** The HMAC key a device code's user code is derived under. */
  RELAY_ENROLL_SECRET: string;
  /** The Web Push signing pair; push is off without a matching pair. */
  RELAY_VAPID_PUBLIC_KEY?: string;
  RELAY_VAPID_PRIVATE_KEY?: string;
}

/** `voice.dormouse.sh`: managed-voice speech and its history sweep. */
export interface VoiceEnv extends WorkerEnv {
  HYPERDRIVE: { connectionString: string };
  ELEVENLABS_API_KEY?: string;
}

/** A rejected provider allowlist throws inside the request, where `onError` answers it. */
export const accountBindings = (env: AccountEnv): AccountEnv => ({
  HYPERDRIVE: env.HYPERDRIVE,
  ASSETS: env.ASSETS,
  RELAY_APPROVE_LIMIT: env.RELAY_APPROVE_LIMIT,
  RELAY_ROOM: env.RELAY_ROOM,
  APP_ORIGIN: env.APP_ORIGIN,
  AUTH_SECRET: env.AUTH_SECRET,
  EMAIL_FROM: env.EMAIL_FROM,
  POSTMARK_SERVER_TOKEN: env.POSTMARK_SERVER_TOKEN,
  BUILD_SHA: env.BUILD_SHA,
  ...providerBindings(env as unknown as Record<string, unknown>),
});

/** Ignores stale production, OAuth, and mail bindings on an existing preview Worker. */
export const accountPreviewBindings = (env: AccountEnv): AccountEnv => ({
  HYPERDRIVE: env.HYPERDRIVE,
  ASSETS: env.ASSETS,
  RELAY_APPROVE_LIMIT: env.RELAY_APPROVE_LIMIT,
  RELAY_ROOM: env.RELAY_ROOM,
  APP_ORIGIN: env.APP_ORIGIN,
  AUTH_SECRET: env.AUTH_SECRET,
  BUILD_SHA: env.BUILD_SHA,
  EMAIL_FROM: "",
  POSTMARK_SERVER_TOKEN: "",
});

/**
 * Hyperdrive for the Relay's own tables and no auth secret: the Relay reads a
 * user row only for its entitlement, never a login. Its secrets are
 * `RELAY_ENROLL_SECRET`, which derives enrollment user codes, and the VAPID
 * pair push is signed with. Production and preview alike.
 */
export const relayBindings = (env: RelayEnv): RelayEnv => ({
  ASSETS: env.ASSETS,
  HYPERDRIVE: env.HYPERDRIVE,
  APP_ORIGIN: env.APP_ORIGIN,
  BUILD_SHA: env.BUILD_SHA,
  ONE_TIME_ROOM: env.ONE_TIME_ROOM,
  RELAY_ROOM: env.RELAY_ROOM,
  ONE_TIME_MINT_LIMIT: env.ONE_TIME_MINT_LIMIT,
  ONE_TIME_JOIN_LIMIT: env.ONE_TIME_JOIN_LIMIT,
  RELAY_SIGNIN_LIMIT: env.RELAY_SIGNIN_LIMIT,
  RELAY_SETUP_LIMIT: env.RELAY_SETUP_LIMIT,
  RELAY_ENROLL_BEGIN_LIMIT: env.RELAY_ENROLL_BEGIN_LIMIT,
  RELAY_ENROLL_POLL_LIMIT: env.RELAY_ENROLL_POLL_LIMIT,
  ACCOUNT_ORIGIN: exactOrigin(env.ACCOUNT_ORIGIN) ?? undefined,
  RELAY_ENROLL_SECRET: env.RELAY_ENROLL_SECRET,
  RELAY_VAPID_PUBLIC_KEY: env.RELAY_VAPID_PUBLIC_KEY,
  RELAY_VAPID_PRIVATE_KEY: env.RELAY_VAPID_PRIVATE_KEY,
});

/** Hyperdrive for the token lookup and the ElevenLabs key; no auth secret. */
export const voiceBindings = (env: VoiceEnv): VoiceEnv => ({
  HYPERDRIVE: env.HYPERDRIVE,
  APP_ORIGIN: env.APP_ORIGIN,
  BUILD_SHA: env.BUILD_SHA,
  ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY,
});

/** A preview never speaks or sweeps: the ElevenLabs key never reaches it. */
export const voicePreviewBindings = (env: VoiceEnv): VoiceEnv => ({
  HYPERDRIVE: env.HYPERDRIVE,
  APP_ORIGIN: env.APP_ORIGIN,
  BUILD_SHA: env.BUILD_SHA,
});
