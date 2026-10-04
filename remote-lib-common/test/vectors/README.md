# Vendored test vectors

## Noise

`noise-ik-25519-chachapoly-sha256.json` is the single `Noise_IK_25519_ChaChaPoly_SHA256` entry lifted verbatim from the `vectors` array of `vectors/cacophony.txt` in [haskell-cryptography/cacophony](https://github.com/haskell-cryptography/cacophony) — an independent Haskell implementation of the Noise Protocol Framework. It is what proves `src/security/noise.ts` byte-for-byte conformant rather than merely self-consistent, so nothing here may be regenerated from our own state machine.

License: Cacophony is released under **The Unlicense** (public domain dedication); see `LICENSE` in that repository.

Field meanings, following Cacophony's format: `*_prologue`, `*_static`, `*_ephemeral`, and `init_remote_static` are hex; static and ephemeral values are raw 32-byte X25519 private scalars, except `init_remote_static`, which is the responder's public key. `messages` holds the two handshake messages followed by transport messages alternating initiator → responder → initiator → responder. `handshake_hash` is the value `Split` reports.

The RFC 7748 section 6.1 X25519 vector and the RFC 8439 section 2.8.2 ChaCha20-Poly1305 vector are inline fixtures in `../noise.test.mjs`.

## RFC 8291 Web Push vector

`rfc8291-appendix-a.json` holds the example of RFC 8291 section 5 and the intermediate values of its Appendix A, copied from the RFC text with the line wrapping removed; every field is base64url, as the RFC prints it. `body` is the section 5 message, which is `header` followed by `ciphertext`. It is what proves `src/remote/web-push.ts` byte-for-byte conformant, so nothing here may be regenerated from our own sender. RFCs are published under the IETF Trust's Legal Provisions, which permit reproducing code components such as these.
