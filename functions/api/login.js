const KOHA_LOGIN_PATH = "/cgi-bin/koha/mainpage.pl";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie() || [];
  }
  const value = headers.get("set-cookie");
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
}

function cookieHeader(setCookies) {
  const jar = new Map();
  for (const raw of setCookies || []) {
    const pair = raw.split(";", 1)[0].trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function mergeSetCookies(first, second) {
  return [...(first || []), ...(second || [])];
}

function hiddenFields(html) {
  const result = {};
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    const name = tag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    const value = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1] || "";
    result[name] = value;
  }
  return result;
}

function hasSessionCookie(cookies) {
  return (cookies || []).some((raw) => /^\s*CGISESSID\s*=/i.test(raw));
}

function rewriteCookie(raw) {
  return raw
    .replace(/;\s*Domain=[^;]+/gi, "")
    .replace(/;\s*Path=[^;]*/gi, "; Path=/koha");
}

export async function onRequestPost(context) {
  try {
    const env = context.env;
    const body = await context.request.json().catch(() => ({}));
    const pin = String(body.pin || body.code || "").trim();

    const configured = {
      SECRET_PIN: Boolean(env.SECRET_PIN),
      KOHA_USER: Boolean(env.KOHA_USER),
      KOHA_PASS: Boolean(env.KOHA_PASS),
      KOHA_BASE_URL: Boolean(env.KOHA_BASE_URL)
    };

    if (!configured.SECRET_PIN) {
      return json({ success: false, error: "Administrative PIN is not configured." }, 500);
    }

    if (pin !== env.SECRET_PIN) {
      return json({ success: false, error: "Invalid administrative passcode." }, 401);
    }

    if (!configured.KOHA_USER || !configured.KOHA_PASS || !configured.KOHA_BASE_URL) {
      console.error("Missing Koha bindings", configured);
      return json({ success: false, error: "Koha authentication is not configured.", configured }, 500);
    }

    const base = new URL(env.KOHA_BASE_URL);
    const loginUrl = new URL(KOHA_LOGIN_PATH, base);

    // Step 1: get Koha's real login page and its session cookie.
    const page = await fetch(loginUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Cache-Control": "no-cache"
      }
    });

    const pageCookies = getSetCookies(page.headers);
    const html = await page.text();

    if (!page.ok && page.status !== 302 && page.status !== 303) {
      console.error("Koha login page failed", page.status);
      return json({ success: false, error: "Unable to reach Koha staff login.", status: page.status }, 502);
    }

    // Step 2: reproduce the actual Koha form, including every hidden field.
    const fields = hiddenFields(html);
    fields.login_userid = env.KOHA_USER;
    fields.login_password = env.KOHA_PASS;
    fields.op = "cud-login";
    fields.koha_login_context = "intranet";

    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);

    const login = await fetch(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(pageCookies),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Referer: loginUrl.toString(),
        Origin: base.origin
      },
      body: form.toString()
    });

    const loginCookies = getSetCookies(login.headers);
    const allCookies = mergeSetCookies(pageCookies, loginCookies);
    const location = login.headers.get("Location") || "";
    const locationUrl = location ? new URL(location, loginUrl) : null;

    // Koha normally redirects to the staff interface after a successful login.
    // Some installations return the dashboard directly instead, so support both.
    let dashboardResponse = false;
    if (!location && login.status >= 200 && login.status < 300) {
      const loginBody = await login.text();
      dashboardResponse =
        /logout/i.test(loginBody) &&
        !/name=["']login_userid["']/i.test(loginBody);
    }

    const redirectSuccess = Boolean(
      locationUrl &&
      locationUrl.hostname === base.hostname &&
      locationUrl.port === base.port &&
      locationUrl.pathname.startsWith("/cgi-bin/koha/")
    );

    const sessionSuccess = hasSessionCookie(allCookies) && (redirectSuccess || dashboardResponse);

    if (!sessionSuccess) {
      console.error("Koha authentication failed", {
        status: login.status,
        location,
        cookie_names: allCookies.map((c) => c.split("=", 1)[0]).join(","),
        has_session_cookie: hasSessionCookie(allCookies)
      });
      return json({
        success: false,
        error: "Koha rejected the staff login.",
        status: login.status,
        has_session_cookie: hasSessionCookie(allCookies),
        redirect: Boolean(redirectSuccess)
      }, 502);
    }

    const response = json({
      success: true,
      redirect: "/koha/cgi-bin/koha/mainpage.pl"
    });

    // Give the browser Koha's session cookie on the /koha proxy path.
    // The proxy will forward it back to Koha on every request.
    const unique = new Map();
    for (const raw of allCookies) {
      const rewritten = rewriteCookie(raw);
      const key = rewritten.split("=", 1)[0];
      unique.set(key, rewritten);
    }
    for (const cookie of unique.values()) {
      response.headers.append("Set-Cookie", cookie);
    }

    return response;
  } catch (error) {
    console.error("NALC login exception", error);
    return json({ success: false, error: "Unable to complete Koha authentication." }, 500);
  }
}
