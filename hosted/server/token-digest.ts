import { createHash } from "node:crypto";

/**
 * Lowercase hex SHA-256 of a bearer token: the form the relay and voice tables
 * store a token in and look it up by. Must stay byte-identical to the `digest`
 * pgstencil exported until 0.5.0, which hashed every row already stored.
 * `node:crypto` reaches workerd through each Worker's `nodejs_compat` flag.
 */
export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
