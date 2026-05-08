// Cloudflare Pages Function: proxies notify-signup to nedshed.dev (Substack
// custom domain). The substackapi.com embed widget is deprecated and silently
// no-ops, so we hit the first-party endpoint server-side. Two failure modes
// the proxy cannot solve:
//   1. Already-subscribed emails — Substack's no-JS endpoint refuses to
//      disclose dedup state and returns "Please enable JavaScript".
//   2. Rate limits / bot heuristics — Substack soft-blocks suspicious-looking
//      callers (datacenter IPs hitting subscribe in volume).
// In both cases we tell the client to fall back to the hosted subscribe page
// (nedshed.dev/subscribe?email=...), which runs Substack's full JS flow and
// handles all cases including already-subscribed.

const SUBSTACK_ENDPOINT = "https://nedshed.dev/api/v1/free?nojs=true";
const FALLBACK_BASE = "https://nedshed.dev/subscribe";

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const fallbackUrl = (email: string) =>
  `${FALLBACK_BASE}?email=${encodeURIComponent(email)}`;

export const onRequestPost = async ({ request }: { request: Request }): Promise<Response> => {
  let email: unknown;
  try {
    ({ email } = (await request.json()) as { email?: unknown });
  } catch {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    return Response.json({ ok: false, error: "Please enter a valid email" }, { status: 400 });
  }

  const clientIp = request.headers.get("CF-Connecting-IP") ?? "";
  const acceptLanguage = request.headers.get("Accept-Language") ?? "en-US,en;q=0.9";

  const body = new URLSearchParams({
    email,
    first_url: "https://mouseterm.com/",
    first_referrer: "",
    current_url: "https://mouseterm.com/",
    current_referrer: "",
    referral_code: "",
    source: "subscribe_modal",
  });

  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://nedshed.dev",
    Referer: "https://nedshed.dev/",
    "User-Agent": BROWSER_UA,
    "Accept-Language": acceptLanguage,
    Accept: "application/json, text/plain, */*",
  };
  if (clientIp) upstreamHeaders["X-Forwarded-For"] = clientIp;

  let upstream: Response;
  try {
    upstream = await fetch(SUBSTACK_ENDPOINT, {
      method: "POST",
      headers: upstreamHeaders,
      body,
    });
  } catch {
    return Response.json(
      { ok: false, fallback: true, fallbackUrl: fallbackUrl(email) },
      { status: 502 },
    );
  }

  if (upstream.ok) {
    return Response.json({ ok: true });
  }

  const text = await upstream.text();

  // Parse the response to decide between inline error (validation) vs fallback
  // redirect (anti-bot, already-subscribed, rate limit, anything else).
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }

  // Substack's standard validation shape: { errors: [{ msg, ... }, ...] }
  // Show those inline so the user can fix their email.
  if (
    parsed && typeof parsed === "object" &&
    Array.isArray((parsed as { errors?: unknown }).errors)
  ) {
    const errors = (parsed as { errors: Array<{ msg?: string }> }).errors;
    const msg = errors[0]?.msg ?? "Please enter a valid email";
    return Response.json({ ok: false, error: msg }, { status: 400 });
  }

  // Anything else (JS-challenge "please enable JavaScript", 429, 5xx, weird
  // shape) — bounce the user to Substack's hosted subscribe page, which runs
  // the full JS flow and handles already-subscribed cleanly.
  return Response.json(
    { ok: false, fallback: true, fallbackUrl: fallbackUrl(email) },
    { status: upstream.status >= 500 ? 502 : 409 },
  );
};
