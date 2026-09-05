import { performKohaLogin } from "../_shared/kohaAuth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestPost(context) {
  try {
    const env = context.env;
    const body = await context.request.json().catch(() => ({}));
    const pin = String(body.pin || body.code || "").trim();

    if (!env.SECRET_PIN) {
      return json({ success: false, error: "Administrative PIN is not configured." }, 500);
    }

    if (pin !== env.SECRET_PIN) {
      return json({ success: false, error: "Invalid administrative passcode." }, 401);
    }

    if (!env.KOHA_USER || !env.KOHA_PASS || !env.KOHA_BASE_URL) {
      console.error("Missing Koha bindings", {
        KOHA_USER: Boolean(env.KOHA_USER),
        KOHA_PASS: Boolean(env.KOHA_PASS),
        KOHA_BASE_URL: Boolean(env.KOHA_BASE_URL)
      });
      return json({ success: false, error: "Koha authentication is not configured." }, 500);
    }

    const clientIp = context.request.headers.get("CF-Connecting-IP");
    const result = await performKohaLogin(env, clientIp);

    if (!result.success) {
      console.error("Koha authentication failed", {
        status: result.status,
        error: result.error,
        hasSessionCookie: result.hasSessionCookie
      });
      return json({
        success: false,
        error: result.error || "Koha rejected the staff login.",
        status: result.status,
        hasSessionCookie: result.hasSessionCookie
      }, result.status || 502);
    }

    const response = json({
      success: true,
      redirect: "/koha/cgi-bin/koha/mainpage.pl"
    });

    for (const cookie of result.cookies) {
      response.headers.append("Set-Cookie", cookie);
    }

    return response;
  } catch (error) {
    console.error("NALC login exception", error);
    return json({ success: false, error: "Unable to complete Koha authentication." }, 500);
  }
}
