// Cloudflare Pages Function: proxies notify-signup to nedshed.dev (Substack
// custom domain). substackapi.com/widget.js is deprecated and silently no-ops;
// the first-party endpoint requires a server-side hop because it doesn't send
// CORS headers.
//
// Forwards the client IP via X-Forwarded-For so Substack rate-limits per
// end-user, not per CF egress IP — without this, all signups share one bucket
// and trip 429s under any real traffic.

const SUBSTACK_ENDPOINT = "https://nedshed.dev/api/v1/free?nojs=true";

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

  const upstream = await fetch(SUBSTACK_ENDPOINT, {
    method: "POST",
    headers: upstreamHeaders,
    body,
  });

  if (upstream.ok) {
    return Response.json({ ok: true });
  }

  const text = await upstream.text();

  if (upstream.status === 429) {
    return Response.json(
      {
        ok: false,
        error: "Too many signups right now. Please try again in a minute.",
        _upstream: { status: 429 },
      },
      { status: 429 },
    );
  }

  let message = "Something went wrong. Please try again.";
  let errorMsgs: string[] = [];
  try {
    const data = JSON.parse(text) as { errors?: Array<{ msg?: string }> };
    if (data.errors) {
      errorMsgs = data.errors.map((e) => e?.msg ?? "").filter(Boolean);
      if (errorMsgs[0]) message = errorMsgs[0];
    }
  } catch {
    // upstream returned non-JSON; keep generic message
  }

  return Response.json(
    {
      ok: false,
      error: message,
      _upstream: { status: upstream.status, errors: errorMsgs, bodyPreview: text.slice(0, 300) },
    },
    { status: upstream.status },
  );
};
