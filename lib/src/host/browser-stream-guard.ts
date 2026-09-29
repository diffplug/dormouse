/** Single-use, short-lived grants that each authorize one viewer socket onto
 *  the view they were issued for, never an address the caller names. */
import { randomBytes } from 'node:crypto';

export class BrowserStreamGrants<T> {
  private grants = new Map<string, { value: T; expires: number }>();
  issue(value: T): string {
    const now = Date.now();
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.grants.delete(token);
    // A host should never accumulate unbounded grants from a malfunctioning view.
    if (this.grants.size >= 1024) this.grants.delete(this.grants.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    this.grants.set(token, { value, expires: now + 60_000 });
    return token;
  }
  /** What `token` was issued for, once: undefined when unknown, spent or expired. */
  consume(token: string): T | undefined {
    const grant = this.grants.get(token);
    this.grants.delete(token);
    return grant && grant.expires > Date.now() ? grant.value : undefined;
  }
}
