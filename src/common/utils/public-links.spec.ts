import { isHttpUrl, resolvePublicWebUrl, staffPasswordLink, storefrontPasswordLink } from './public-links';

describe('resolvePublicWebUrl', () => {
  it('prefers PUBLIC_WEB_URL, without a trailing slash', () => {
    expect(resolvePublicWebUrl('https://yws.example.com/', ['https://other.example.com'])).toBe(
      'https://yws.example.com',
    );
  });

  it('falls back to the first CORS origin', () => {
    expect(resolvePublicWebUrl(undefined, ['https://yws.example.com', 'http://localhost:5173'])).toBe(
      'https://yws.example.com',
    );
    expect(resolvePublicWebUrl('  ', ['https://yws.example.com'])).toBe('https://yws.example.com');
  });

  it('is null when neither is configured', () => {
    expect(resolvePublicWebUrl(undefined, [])).toBeNull();
  });
});

describe('isHttpUrl', () => {
  it.each(['https://yws.example.com', 'http://localhost:5173'])('accepts %s', (value) => {
    expect(isHttpUrl(value)).toBe(true);
  });

  it.each(['yws.example.com', 'ftp://yws.example.com', 'javascript:alert(1)', ''])('rejects %j', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });
});

describe('password links', () => {
  it('sends staff to the web admin login', () => {
    expect(staffPasswordLink('https://yws.example.com', 'abc')).toBe('https://yws.example.com/login?token=abc');
  });

  it("sends customers to their store's login, which works with or without per-store subdomains", () => {
    expect(storefrontPasswordLink('https://yws.example.com', 'mi-tienda', 'abc')).toBe(
      'https://yws.example.com/store/mi-tienda/login?token=abc',
    );
  });
});
