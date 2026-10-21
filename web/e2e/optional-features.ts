// Endpoints for optional features (MCP, model sign-in, Agent settings, composer
// commands/files, companion). The Web UI hides their entry points when the
// server answers 404, so route fixtures that do not exercise them return 404.
const optional = [
  /^\/v1\/mcp(\/|$)/,
  /^\/v1\/provider-auth(\/|$)/,
  /^\/v1\/settings$/,
  /^\/v1\/companion\//,
  /^\/v1\/projects\/[^/]+\/(mcp|commands|files|companion)(\/|$)/,
  /^\/v1\/sessions\/[^/]+\/(commands|files|command-prompt)$/,
];

export function isOptionalFeature(pathname: string): boolean {
  return optional.some(pattern => pattern.test(pathname));
}

export const notFound = { status: 404, contentType: "application/json",
  body: JSON.stringify({ statusCode: 404, error: "Not Found", message: "optional feature not mocked" }) };
