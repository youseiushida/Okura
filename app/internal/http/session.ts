export type Fetcher = (input: URL | Request | string, init?: RequestInit) => Promise<Response>;

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  expiresAt?: number;
}

export class CookieStore {
  readonly #cookies: StoredCookie[] = [];

  remember(response: Response, requestURL: URL): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? this.#fallbackSetCookie(headers);
    for (const value of values) this.set(value, requestURL, true);
  }

  set(header: string, requestURL: URL, fromHTTP: boolean): void {
    const parts = header.split(";");
    const pair = parts.shift() ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) return;

    const cookie: StoredCookie = {
      name: pair.slice(0, separator).trim(),
      value: pair.slice(separator + 1).trim(),
      domain: requestURL.hostname.toLowerCase(),
      path: defaultCookiePath(requestURL.pathname),
      hostOnly: true,
      secure: false,
      httpOnly: false,
    };
    let remove = false;

    for (const rawAttribute of parts) {
      const attributeSeparator = rawAttribute.indexOf("=");
      const name =
        (attributeSeparator < 0 ? rawAttribute : rawAttribute.slice(0, attributeSeparator)).trim()
          .toLowerCase();
      const value = attributeSeparator < 0 ? "" : rawAttribute.slice(attributeSeparator + 1).trim();
      switch (name) {
        case "domain": {
          const domain = value.replace(/^\./, "").toLowerCase();
          if (!domainMatches(requestURL.hostname, domain)) return;
          cookie.domain = domain;
          cookie.hostOnly = false;
          break;
        }
        case "path":
          cookie.path = value.startsWith("/") ? value : "/";
          break;
        case "secure":
          cookie.secure = true;
          break;
        case "httponly":
          cookie.httpOnly = fromHTTP;
          break;
        case "expires": {
          const expiresAt = Date.parse(value);
          if (!Number.isNaN(expiresAt)) cookie.expiresAt = expiresAt;
          break;
        }
        case "max-age": {
          const seconds = Number(value);
          if (Number.isFinite(seconds)) {
            remove = seconds <= 0;
            cookie.expiresAt = Date.now() + seconds * 1000;
          }
          break;
        }
      }
    }

    const index = this.#cookies.findIndex((existing) =>
      existing.name === cookie.name && existing.domain === cookie.domain &&
      existing.path === cookie.path
    );
    if (remove || (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now())) {
      if (index >= 0) this.#cookies.splice(index, 1);
      return;
    }
    if (index >= 0) this.#cookies[index] = cookie;
    else this.#cookies.push(cookie);
  }

  header(url: URL, includeHTTPOnly = true): string {
    const now = Date.now();
    return this.#cookies
      .filter((cookie) => {
        if (!includeHTTPOnly && cookie.httpOnly) return false;
        if (cookie.secure && url.protocol !== "https:") return false;
        if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) return false;
        const matchesHost = cookie.hostOnly
          ? url.hostname.toLowerCase() === cookie.domain
          : domainMatches(url.hostname, cookie.domain);
        return matchesHost && pathMatches(url.pathname, cookie.path);
      })
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  #fallbackSetCookie(headers: Headers): string[] {
    const value = headers.get("set-cookie");
    return value === null ? [] : [value];
  }
}

export class HttpSession {
  readonly cookies = new CookieStore();
  readonly #fetch: Fetcher;

  constructor(fetcher: Fetcher = fetch) {
    this.#fetch = fetcher;
  }

  async request(input: URL | string, init: RequestInit = {}): Promise<Response> {
    let url = new URL(input);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    const headers = new Headers(init.headers);

    for (let redirects = 0; redirects <= 10; redirects += 1) {
      const requestHeaders = new Headers(headers);
      const cookie = this.cookies.header(url);
      if (cookie !== "") requestHeaders.set("Cookie", cookie);
      else requestHeaders.delete("Cookie");

      const response = await this.#fetch(url, {
        ...init,
        method,
        body,
        headers: requestHeaders,
        redirect: "manual",
      });
      this.cookies.remember(response, url);

      if (!isRedirect(response.status)) return response;
      const location = response.headers.get("Location");
      if (location === null || redirects === 10) return response;
      const nextURL = new URL(location, url);
      const crossOrigin = nextURL.origin !== url.origin;
      if (url.protocol === "https:" && nextURL.protocol !== "https:") {
        await response.body?.cancel();
        throw new Error("refusing an HTTPS redirect to a non-HTTPS URL");
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("Content-Type");
        headers.delete("Content-Length");
      }
      if (crossOrigin) {
        if (body !== undefined || (method !== "GET" && method !== "HEAD")) {
          await response.body?.cancel();
          throw new Error("refusing a cross-origin redirect that preserves the request body");
        }
        for (
          const name of [
            "Authorization",
            "Proxy-Authorization",
            "Cookie",
            "Origin",
            "Referer",
          ]
        ) {
          headers.delete(name);
        }
      }
      await response.body?.cancel();
      url = nextURL;
    }
    throw new Error("too many redirects");
  }
}

function defaultCookiePath(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : pathname.slice(0, slash + 1);
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || pathname.charAt(cookiePath.length) === "/";
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
