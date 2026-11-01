// Rules: docs/specs/hosted.md -> "Relay sockets".
import { WorkerEntrypoint } from "cloudflare:workers";
import { withClient } from "pgstencil/postgres";
import type { RelayEnv } from "./bindings";
import {
  burrowsById,
  sessionsByHash,
  type Client,
  type RelayBurrow,
  type RelaySessionOwner,
} from "./relay-auth";

/**
 * The relay Worker's database read for its own `RelayRoom`s, reached through
 * `ctx.exports` as a Worker invocation of its own, so an object never holds a
 * database connection. A named entrypoint: no route and no binding reaches it.
 */
export class RelayRows extends WorkerEntrypoint<Pick<RelayEnv, "HYPERDRIVE">> {
  /** Those of `burrowIds` still enrolled, each with its owner. */
  burrows(burrowIds: string[]): Promise<RelayBurrow[]> {
    return withClient(this.env.HYPERDRIVE.connectionString, (db: Client) =>
      burrowsById(db, burrowIds),
    );
  }

  /** Those of the sessions hashed `tokenHashes` still live, each with its owner. */
  sessions(tokenHashes: string[]): Promise<RelaySessionOwner[]> {
    return withClient(this.env.HYPERDRIVE.connectionString, (db: Client) =>
      sessionsByHash(db, tokenHashes),
    );
  }
}
