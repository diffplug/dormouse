// Rules: docs/specs/hosted.md -> "Managed voice".
import { SecureRandom, token as randomToken } from "pgstencil";

/** A fresh voice token, `dmv_` plus base64url of 32 random bytes; only its SHA-256 is stored. */
export const mintVoiceToken = () => "dmv_" + randomToken(new SecureRandom());
