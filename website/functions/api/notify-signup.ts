// Cloudflare Pages Function: proxies notify-signup to nedshed.dev (Substack
// custom domain). substackapi.com/widget.js is deprecated and silently no-ops;
// the first-party endpoint requires a server-side hop because it doesn't send
// CORS headers.

const SUBSTACK_ENDPOINT = "https://nedshed.dev/api/v1/free?nojs=true";

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

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

  const body = new URLSearchParams({
    email,
    first_url: "https://mouseterm.com/",
    first_referrer: "",
    current_url: "https://mouseterm.com/",
    current_referrer: "",
    referral_code: "",
    source: "subscribe_modal",
  });

  const upstream = await fetch(SUBSTACK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://nedshed.dev",
      Referer: "https://nedshed.dev/",
    },
    body,
  });

  if (upstream.ok) {
    return Response.json({ ok: true });
  }

  const text = await upstream.text();
  let message = "Something went wrong. Please try again.";
  try {
    const data = JSON.parse(text) as { errors?: Array<{ msg?: string }> };
    if (data.errors?.[0]?.msg) message = data.errors[0].msg;
  } catch {
    // upstream returned non-JSON; keep generic message
  }
  return Response.json({ ok: false, error: message }, { status: upstream.status });
};
