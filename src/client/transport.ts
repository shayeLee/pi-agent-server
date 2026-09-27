/// <reference lib="dom" />

/** Fetch-compatible transport; callers can inject native, test, or platform-specific fetch implementations. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Static headers or a provider evaluated for each request/connection. */
export type HeadersProvider = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

/** Token or token provider; an empty token omits the Authorization header. */
export type AuthToken = string | (() => string | null | undefined | Promise<string | null | undefined>);

export const defaultFetch: FetchLike = (input, init) => {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Fetch API is unavailable; provide a fetch implementation.");
  }
  return globalThis.fetch(input, init);
};

/** Convert Fetch API header forms to a plain object for broad fetch/polyfill compatibility. */
export function resolveHeaders(
  provider?: HeadersProvider,
): Record<string, string> | Promise<Record<string, string>> {
  if (typeof provider === "function") {
    return Promise.resolve(provider()).then(headersToRecord);
  }
  return headersToRecord(provider);
}

function headersToRecord(value?: HeadersInit): Record<string, string> {
  if (!value) return {};

  const headers: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const [name, headerValue] of value) headers[name] = headerValue;
  } else if (typeof Headers !== "undefined" && value instanceof Headers) {
    value.forEach((headerValue, name) => {
      headers[name] = headerValue;
    });
  } else {
    Object.assign(headers, value);
  }
  return headers;
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalizedName);
}
