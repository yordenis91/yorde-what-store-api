import type { Request } from 'express';
import { sseQueryTokenExtractor } from './jwt.strategy';

function request(path: string, url: string): Request {
  return { path, url } as Request;
}

describe('sseQueryTokenExtractor', () => {
  it('reads ?access_token= on the order-events SSE route', () => {
    const req = request('/api/v1/orders/events', '/api/v1/orders/events?access_token=abc123');
    expect(sseQueryTokenExtractor(req)).toBe('abc123');
  });

  it('ignores ?access_token= on every other route, however similarly named', () => {
    const req = request('/api/v1/auth/login', '/api/v1/auth/login?access_token=stolen');
    expect(sseQueryTokenExtractor(req)).toBeNull();
  });

  it('ignores ?access_token= on a route that merely contains "events" but is not the SSE endpoint', () => {
    const req = request('/api/v1/platform/tenants/events', '/api/v1/platform/tenants/events?access_token=stolen');
    expect(sseQueryTokenExtractor(req)).toBeNull();
  });

  it('returns null on the SSE route when no token is present', () => {
    const req = request('/api/v1/orders/events', '/api/v1/orders/events');
    expect(sseQueryTokenExtractor(req)).toBeNull();
  });
});
