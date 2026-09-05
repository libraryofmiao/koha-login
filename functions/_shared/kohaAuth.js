// Shared Koha "log in as the configured staff account" logic.
// Used by both /api/login (first sign-in) and the /koha/* proxy
// (silent re-authentication when Koha ends a session early).

const KOHA_LOGIN_PATH = "/cgi-bin/koha/mainpage.pl";

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
  let out = raw
    .replace(/;\s*Domain=[^;]+/gi, "")
    .replace(/;\s*Path=[^;]*/gi, "; Path=/koha")
    .replace(/;\s*SameSite=[^;]*/gi, "");
  return `${out}; SameSite=Lax`;
}

/**
 * Logs in to the real Koha staff interface using the configured
 * KOHA_USER / KOHA_PASS, the same way a browser submitting the real
 * Koha login form would. Returns the rewritten Set-Cookie strings for
 * the resulting session on success.
 */
export async function performKohaLogin(env, clientIp) {
  const configured = {
    KOHA_USER: Boolean(env.KOHA_USER),
    KOHA_PASS: Boolean(env.KOHA_PASS),
    KOHA_BASE_URL: Boolean(env.KOHA_BASE_URL)
  };

  if (!configured.KOHA_USER || !configured.KOHA_PASS || !configured.KOHA_BASE_URL) {
    return { success: false, status: 500, error: "Koha authentication is not configured.", configured, cookies: [] };
  }

  const base = new URL(env.KOHA_BASE_URL);
  const loginUrl = new URL(KOHA_LOGIN_PATH, base);
  const clientIpHeaders = clientIp ? { "X-Forwarded-For": clientIp } : {};

  const page = await fetch(loginUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      ...clientIpHeaders,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Cache-Control": "no-cache"
    }
  });

  const pageCookies = getSetCookies(page.headers);
  const html = await page.text();

  if (!page.ok && page.status !== 302 && page.status !== 303) {
    return { success: false, status: 502, error: "Unable to reach Koha staff login.", cookies: [] };
  }

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
      ...clientIpHeaders,
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

  const redirectSuccess = Boolean(
    locationUrl &&
    locationUrl.hostname === base.hostname &&
    locationUrl.port === base.port &&
    locationUrl.pathname.startsWith("/cgi-bin/koha/")
  );

  const sessionSuccess = hasSessionCookie(allCookies) && (redirectSuccess || (login.status >= 200 && login.status < 300));

  if (!sessionSuccess) {
    return {
      success: false,
      status: 502,
      error: "Koha rejected the staff login.",
      hasSessionCookie: hasSessionCookie(allCookies),
      cookies: []
    };
  }

  const unique = new Map();
  for (const raw of allCookies) {
    const rewritten = rewriteCookie(raw);
    const key = rewritten.split("=", 1)[0];
    unique.set(key, rewritten);
  }

  return { success: true, status: 200, cookies: Array.from(unique.values()) };
}
