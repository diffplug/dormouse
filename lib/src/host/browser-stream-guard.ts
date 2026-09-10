/** Single-use, short-lived grants authorize one browser stream, never an upstream address. */
import { randomBytes } from 'node:crypto';
export class BrowserStreamGrants {
  private grants = new Map<string, { port: number; expires: number }>();
  issue(port: number): string {
    const now = Date.now();
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.grants.delete(token);
    // A host should never accumulate unbounded grants from a malfunctioning view.
    if (this.grants.size >= 1024) this.grants.delete(this.grants.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    this.grants.set(token, { port, expires: now + 60_000 });
    return token;
  }
  consume(token: string, port: number): boolean {
    const grant = this.grants.get(token);
    this.grants.delete(token);
    return !!grant && grant.port === port && grant.expires > Date.now();
  }
}
