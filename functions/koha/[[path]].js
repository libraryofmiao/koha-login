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

function copyRequestHeaders(request, env, baseUrl) {
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }

    headers.set("Host", baseUrl.host);
    headers.set("X-Forwarded-Proto", "http");
    headers.set("X-Forwarded-Host", new URL(request.url).host);

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
        html = html.split(`\"${prefix}`).join(`\"/koha${prefix}`);
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
        const rewritten = cookie
            .replace(/;\s*Domain=[^;]+/gi, "")
            .replace(/;\s*Path=[^;]*/gi, "; Path=/koha")
            .replace(/;\s*SameSite=[^;]*/gi, "; SameSite=Lax");
        target.append("Set-Cookie", rewritten);
    }
}

export async function onRequest(context) {
    try {
        const baseUrl = getConfig(context.env);
        const incomingUrl = new URL(context.request.url);
        const routePath = context.params.path;
        const path = Array.isArray(routePath) ? routePath.join("/") : (routePath || "");
        const upstreamUrl = new URL(`/${path}`, baseUrl);
        upstreamUrl.search = incomingUrl.search;

        const headers = copyRequestHeaders(context.request, context.env, baseUrl);
        const upstream = await fetch(upstreamUrl.toString(), {
            method: context.request.method,
            headers,
            body: ["GET", "HEAD"].includes(context.request.method) ? undefined : context.request.body,
            redirect: "manual"
        });

        const responseHeaders = new Headers();
        for (const name of RESPONSE_HEADERS) {
            const value = upstream.headers.get(name);
            if (value) responseHeaders.set(name, value);
        }

        const location = rewriteLocation(upstream.headers.get("Location"), incomingUrl.origin, baseUrl);
        if (location) responseHeaders.set("Location", location);
        copySetCookies(upstream.headers, responseHeaders);

        responseHeaders.set("Cache-Control", "no-store");
        responseHeaders.set("X-Content-Type-Options", "nosniff");

        const contentType = upstream.headers.get("Content-Type") || "";
        if (contentType.includes("text/html")) {
            const html = rewriteHtml(await upstream.text(), baseUrl);
            return new Response(html, {
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
