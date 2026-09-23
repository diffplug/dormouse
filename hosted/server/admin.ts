// Temporary, spec-recorded exception to "identify accounts by immutable user ID,
// never email": docs/specs/hosted.md -> "Managed voice". Callers recheck on every
// request; nothing may cache the answer or key anything else off this address.
export const ADMIN_EMAIL = "ned.twigg@diffplug.com";

export function isAdmin(user: {
  email?: unknown;
  emailVerified?: unknown;
}): boolean {
  return user.emailVerified === true && user.email === ADMIN_EMAIL;
}
