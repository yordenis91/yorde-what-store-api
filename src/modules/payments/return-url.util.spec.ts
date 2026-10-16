import { isAllowedReturnUrl, type ReturnUrlRules } from './return-url.util';

const rules: ReturnUrlRules = {
  corsOrigins: ['https://app.example.com'],
  rootDomain: 'example.com',
  slug: 'acme',
  subdomain: null,
  customDomain: 'shop.acme.test',
};

describe('isAllowedReturnUrl', () => {
  it('accepts the web client and the store on its own subdomain (resolved by slug)', () => {
    expect(isAllowedReturnUrl('https://app.example.com/store/acme/order-confirmed/1', rules)).toBe(true);
    expect(isAllowedReturnUrl('https://acme.example.com/order-confirmed/1', rules)).toBe(true);
  });

  it('accepts a dev port and either scheme, since the port is not part of the host', () => {
    expect(isAllowedReturnUrl('http://acme.example.com:5173/checkout', rules)).toBe(true);
  });

  it('accepts the explicit subdomain column and the custom domain', () => {
    expect(isAllowedReturnUrl('https://tienda.example.com/x', { ...rules, subdomain: 'tienda' })).toBe(true);
    expect(isAllowedReturnUrl('https://shop.acme.test/x', rules)).toBe(true);
  });

  it("refuses another store's subdomain", () => {
    expect(isAllowedReturnUrl('https://other.example.com/x', rules)).toBe(false);
  });

  it('refuses a look-alike host that merely starts with the store label', () => {
    expect(isAllowedReturnUrl('https://acme.example.com.evil.test/x', rules)).toBe(false);
    expect(isAllowedReturnUrl('https://acme.evil.test/x', rules)).toBe(false);
    expect(isAllowedReturnUrl('https://acme.sub.example.com/x', rules)).toBe(false);
  });

  it('refuses every subdomain when subdomain mode is off', () => {
    expect(isAllowedReturnUrl('https://acme.example.com/x', { ...rules, rootDomain: null })).toBe(false);
    expect(isAllowedReturnUrl('https://app.example.com/x', { ...rules, rootDomain: null })).toBe(true);
  });

  it('refuses non-web schemes and garbage', () => {
    expect(isAllowedReturnUrl('javascript:alert(1)', rules)).toBe(false);
    expect(isAllowedReturnUrl('ftp://acme.example.com/x', rules)).toBe(false);
    expect(isAllowedReturnUrl('not a url', rules)).toBe(false);
  });
});
