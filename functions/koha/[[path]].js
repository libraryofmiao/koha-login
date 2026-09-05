import { performKohaLogin } from "../_shared/kohaAuth.js";

function getConfig(env) {
  if (!env.KOHA_BASE_URL) throw new Error("KOHA_BASE_URL is not configured");
  return new URL(env.KOHA_BASE_URL);
}

const REQUEST_HEADERS = [
  "accept", "accept-language", "authorization", "content-type", "cookie",
  "origin", "referer", "user-agent"
];

const RESPONSE_HEADERS = [
  "cache-control", "content-language", "content-type", "etag", "expires",
  "last-modified", "pragma", "vary", "www-authenticate"
];

function copyRequestHeaders(request, env, baseUrl, cookieOverride) {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  if (cookieOverride !== undefined) {
    if (cookieOverride) headers.set("Cookie", cookieOverride);
    else headers.delete("Cookie");
  }

  headers.set("Host", baseUrl.host);
  headers.set("X-Forwarded-Proto", "https");
  headers.set("X-Forwarded-Host", new URL(request.url).host);

  // Preserve the real client IP that Cloudflare provides. Overwrite any
  // browser-supplied value so Koha receives a trusted, stable client IP.
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) headers.set("X-Forwarded-For", clientIp);

  if (env.KOHA_ACCESS_CLIENT_ID && env.KOHA_ACCESS_CLIENT_SECRET) {
    headers.set("CF-Access-Client-Id", env.KOHA_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.KOHA_ACCESS_CLIENT_SECRET);
  }

  return headers;
}

function rewriteLocation(location, publicOrigin, baseUrl) {
  if (!location) return null;
  try {
    const absolute = new URL(location, baseUrl);
    if (absolute.hostname === baseUrl.hostname && absolute.port === baseUrl.port) {
      return `${publicOrigin}/koha${absolute.pathname}${absolute.search}${absolute.hash}`;
    }
    return location;
  } catch {
    return location.startsWith("/") ? `/koha${location}` : location;
  }
}

function rewriteHtml(html, baseUrl) {
  const prefixes = ["/cgi-bin/koha/", "/intranet-tmpl/", "/opac-tmpl/", "/api/v1/", "/svc/"];

  for (const prefix of prefixes) {
    html = html.split(`"${prefix}`).join(`"/koha${prefix}`);
    html = html.split(`'${prefix}`).join(`'/koha${prefix}`);
    html = html.split(`(${prefix}`).join(`(/koha${prefix}`);
    html = html.split(`=${prefix}`).join(`=/koha${prefix}`);
  }

  html = html.split(`${baseUrl.origin}/`).join(`/koha/`);
  return html;
}

function copySetCookies(source, target) {
  const cookies = typeof source.getSetCookie === "function"
    ? source.getSetCookie()
    : (typeof source.getAll === "function" ? source.getAll("Set-Cookie") : []);

  for (const cookie of cookies || []) {
    let rewritten = cookie
      .replace(/;\s*Domain=[^;]+/gi, "")
      .replace(/;\s*Path=[^;]*/gi, "; Path=/koha")
      .replace(/;\s*SameSite=[^;]*/gi, "");
    rewritten += "; SameSite=Lax";
    target.append("Set-Cookie", rewritten);
  }
}

// Koha's real staff login form always carries these two field names.
// Seeing them in a proxied response means Koha silently ended the
// session (IP re-check, timeout, etc.) and served its login page
// instead of the page that was actually requested.
function looksLikeKohaLoginPage(html) {
  return html.includes('name="login_userid"') && html.includes('name="login_password"');
}

function mergeCookieHeader(originalHeader, freshCookies) {
  const jar = new Map();
  for (const part of (originalHeader || "").split(";")) {
    const pair = part.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const raw of freshCookies || []) {
    const pair = raw.split(";", 1)[0].trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function onRequest(context) {
  try {
    const baseUrl = getConfig(context.env);
    const incomingUrl = new URL(context.request.url);
    const routePath = context.params.path;
    const path = Array.isArray(routePath) ? routePath.join("/") : (routePath || "");
    const upstreamUrl = new URL(`/${path}`, baseUrl);
    upstreamUrl.search = incomingUrl.search;

    const method = context.request.method;
    const hasBody = !("GET" === method || "HEAD" === method);
    const bodyBuffer = hasBody ? await context.request.arrayBuffer() : undefined;

    const runUpstream = (cookieOverride) => fetch(upstreamUrl.toString(), {
      method,
      headers: copyRequestHeaders(context.request, context.env, baseUrl, cookieOverride),
      body: hasBody ? bodyBuffer : undefined,
      redirect: "manual"
    });

    let upstream = await runUpstream();
    let contentType = upstream.headers.get("Content-Type") || "";
    let html = contentType.includes("text/html") ? await upstream.text() : null;

    // Session was silently dropped mid-browse: log back in with the
    // configured staff credentials and retry the exact same request once,
    // so the visitor never has to manually re-authenticate for this.
    let freshCookies = null;
    if (html && looksLikeKohaLoginPage(html) && context.env.KOHA_USER && context.env.KOHA_PASS) {
      const clientIp = context.request.headers.get("CF-Connecting-IP");
      const relogin = await performKohaLogin(context.env, clientIp);
      if (relogin.success) {
        freshCookies = relogin.cookies;
        const mergedCookie = mergeCookieHeader(context.request.headers.get("Cookie"), freshCookies);
        upstream = await runUpstream(mergedCookie);
        contentType = upstream.headers.get("Content-Type") || "";
        html = contentType.includes("text/html") ? await upstream.text() : null;
      } else {
        console.error("Silent Koha re-auth failed", relogin);
      }
    }

    const responseHeaders = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    const location = rewriteLocation(upstream.headers.get("Location"), incomingUrl.origin, baseUrl);
    if (location) responseHeaders.set("Location", location);
    copySetCookies(upstream.headers, responseHeaders);

    if (freshCookies) {
      // Make sure the freshly issued Koha session reaches the browser even
      // if this particular upstream response didn't itself set a cookie.
      const already = new Set(
        (typeof responseHeaders.getSetCookie === "function" ? responseHeaders.getSetCookie() : [])
          .map((c) => c.split("=", 1)[0])
      );
      for (const raw of freshCookies) {
        const name = raw.split("=", 1)[0];
        if (!already.has(name)) {
          responseHeaders.append("Set-Cookie", raw);
          already.add(name);
        }
      }
    }

    // Keep dynamic Koha pages uncached, but allow versioned/static staff assets
    // to be cached at the browser/Cloudflare edge. These assets do not carry
    // Koha session state and their versioned filenames make long-lived caching safe.
    const isStaticAsset =
      incomingUrl.pathname.startsWith("/koha/intranet-tmpl/") &&
      !incomingUrl.pathname.includes("/cgi-bin/");
    responseHeaders.set(
      "Cache-Control",
      isStaticAsset ? "public, max-age=86400, s-maxage=86400" : "no-store"
    );
    responseHeaders.set("X-Content-Type-Options", "nosniff");

    if (html !== null) {
      return new Response(rewriteHtml(html, baseUrl), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  } catch (err) {
    console.error("Koha proxy error", err);
    return new Response("Koha service is temporarily unavailable.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" }
    });
  }
}
