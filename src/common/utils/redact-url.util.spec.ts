import { redactUrl } from './redact-url.util';

describe('redactUrl', () => {
  it('hides the JWT the order-events stream carries in its query string', () => {
    expect(redactUrl('/api/v1/orders/events?access_token=eyJhbGciOi.abc.def&tenantId=t1')).toBe(
      '/api/v1/orders/events?access_token=[redacted]&tenantId=t1',
    );
  });

  it('hides reset and refresh tokens wherever they sit in the query', () => {
    expect(redactUrl('/login?token=abc123')).toBe('/login?token=[redacted]');
    expect(redactUrl('/x?a=1&refresh_token=zzz')).toBe('/x?a=1&refresh_token=[redacted]');
  });

  it('leaves an ordinary URL and an undefined value alone', () => {
    expect(redactUrl('/api/v1/orders?page=2&limit=10')).toBe('/api/v1/orders?page=2&limit=10');
    expect(redactUrl(undefined)).toBeUndefined();
  });
});
