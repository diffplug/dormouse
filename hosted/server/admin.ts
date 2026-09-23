// Rules: docs/specs/hosted.md -> "Managed voice".
export const ADMIN_EMAIL = "ned.twigg@diffplug.com";

export function isAdmin(user: {
  email?: unknown;
  emailVerified?: unknown;
}): boolean {
  return user.emailVerified === true && user.email === ADMIN_EMAIL;
}
