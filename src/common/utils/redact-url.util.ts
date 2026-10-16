/** Query parameters that carry a credential. EventSource cannot set headers, so the stream passes its JWT in the URL. */
const SECRET_QUERY_PARAMS = /([?&](?:access_token|token|refresh_token|code)=)[^&#]*/gi;

/** A request URL that is safe to write to logs, Sentry and error responses. */
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(SECRET_QUERY_PARAMS, '$1[redacted]');
}
