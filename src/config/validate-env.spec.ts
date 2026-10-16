import { validateEnv } from './validate-env';

const VALID_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_CUSTOMER_SECRET: 'c'.repeat(32),
  JWT_CUSTOMER_REFRESH_SECRET: 'd'.repeat(32),
  ENCRYPTION_KEY: 'e'.repeat(32),
};

describe('validateEnv', () => {
  it('returns the config unchanged when every required var is set', () => {
    expect(validateEnv({ ...VALID_ENV, SOME_OTHER_VAR: 'x' })).toEqual({ ...VALID_ENV, SOME_OTHER_VAR: 'x' });
  });

  it('throws naming every missing variable when one is absent', () => {
    const { ENCRYPTION_KEY: _omit, ...rest } = VALID_ENV;
    expect(() => validateEnv(rest)).toThrow(/ENCRYPTION_KEY/);
  });

  it('throws when a required var is present but empty', () => {
    expect(() => validateEnv({ ...VALID_ENV, JWT_SECRET: '' })).toThrow(/JWT_SECRET/);
  });

  it('throws when a required var is only whitespace', () => {
    expect(() => validateEnv({ ...VALID_ENV, JWT_SECRET: '   ' })).toThrow(/JWT_SECRET/);
  });

  it('lists every missing variable, not just the first', () => {
    expect(() => validateEnv({})).toThrow(
      /DATABASE_URL.*JWT_SECRET.*JWT_REFRESH_SECRET.*JWT_CUSTOMER_SECRET.*JWT_CUSTOMER_REFRESH_SECRET.*ENCRYPTION_KEY/s,
    );
  });

  describe('CORS_ORIGINS in production', () => {
    it('throws when NODE_ENV=production and CORS_ORIGINS is unset', () => {
      expect(() => validateEnv({ ...VALID_ENV, NODE_ENV: 'production' })).toThrow(/CORS_ORIGINS/);
    });

    it('throws when NODE_ENV=production and CORS_ORIGINS is an empty string', () => {
      expect(() => validateEnv({ ...VALID_ENV, NODE_ENV: 'production', CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/);
    });

    it('throws when NODE_ENV=production and CORS_ORIGINS is only whitespace', () => {
      expect(() => validateEnv({ ...VALID_ENV, NODE_ENV: 'production', CORS_ORIGINS: '   ' })).toThrow(/CORS_ORIGINS/);
    });

    it('passes when NODE_ENV=production and CORS_ORIGINS is set', () => {
      expect(() =>
        validateEnv({ ...VALID_ENV, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' }),
      ).not.toThrow();
    });

    it('does not require CORS_ORIGINS outside production', () => {
      expect(() => validateEnv({ ...VALID_ENV, NODE_ENV: 'development' })).not.toThrow();
      expect(() => validateEnv({ ...VALID_ENV })).not.toThrow();
    });
  });

  describe('PUBLIC_WEB_URL', () => {
    it('passes when unset (links fall back to the first CORS origin)', () => {
      expect(() => validateEnv({ ...VALID_ENV })).not.toThrow();
    });

    it('passes with an absolute http(s) URL', () => {
      expect(() => validateEnv({ ...VALID_ENV, PUBLIC_WEB_URL: 'https://yws.example.com' })).not.toThrow();
    });

    it('throws on a value that is not an absolute http(s) URL, instead of emailing broken links', () => {
      expect(() => validateEnv({ ...VALID_ENV, PUBLIC_WEB_URL: 'yws.example.com' })).toThrow(/PUBLIC_WEB_URL/);
    });
  });

  describe('TRUST_PROXY', () => {
    it('accepts a hop count and an unset value', () => {
      expect(() => validateEnv({ ...VALID_ENV, TRUST_PROXY: '2' })).not.toThrow();
      expect(() => validateEnv({ ...VALID_ENV })).not.toThrow();
    });

    it('refuses "true", which would trust any forged X-Forwarded-For', () => {
      expect(() => validateEnv({ ...VALID_ENV, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    });
  });

  describe('in production', () => {
    const PROD = {
      ...VALID_ENV,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://shop.example.com',
      JWT_SECRET: 'access-'.padEnd(40, 'a'),
      JWT_REFRESH_SECRET: 'refresh-'.padEnd(40, 'b'),
      JWT_CUSTOMER_SECRET: 'customer-'.padEnd(40, 'c'),
      JWT_CUSTOMER_REFRESH_SECRET: 'customerrefresh-'.padEnd(40, 'd'),
      ENCRYPTION_KEY: 'encryption-'.padEnd(40, 'e'),
    };

    it('accepts long, distinct, non-placeholder secrets', () => {
      expect(() => validateEnv(PROD)).not.toThrow();
    });

    it('refuses the placeholder values .env.example ships with', () => {
      expect(() => validateEnv({ ...PROD, JWT_SECRET: 'change_me_access_secret' })).toThrow(/JWT_SECRET.*placeholder/);
      expect(() => validateEnv({ ...PROD, ENCRYPTION_KEY: 'change_me_32_byte_minimum_secret' })).toThrow(
        /ENCRYPTION_KEY.*placeholder/,
      );
    });

    it('refuses a secret that is too short to be one', () => {
      expect(() => validateEnv({ ...PROD, JWT_REFRESH_SECRET: 'short' })).toThrow(/JWT_REFRESH_SECRET.*shorter/);
    });

    it('refuses JWT secrets that are reused, since a refresh token would pass as an access token', () => {
      expect(() => validateEnv({ ...PROD, JWT_REFRESH_SECRET: PROD.JWT_SECRET })).toThrow(/different/);
    });

    it('refuses an encryption key equal to a JWT secret', () => {
      expect(() => validateEnv({ ...PROD, ENCRYPTION_KEY: PROD.JWT_SECRET })).toThrow(/ENCRYPTION_KEY must differ/);
    });

    it('does not apply outside production, so local setups keep their throwaway values', () => {
      expect(() =>
        validateEnv({ ...VALID_ENV, NODE_ENV: 'development', JWT_SECRET: 'change_me_access_secret' }),
      ).not.toThrow();
    });
  });

  describe('STOREFRONT_ROOT_DOMAIN', () => {
    it('accepts a bare domain, or none at all', () => {
      expect(() => validateEnv({ ...VALID_ENV, STOREFRONT_ROOT_DOMAIN: 'midominio.com' })).not.toThrow();
      expect(() => validateEnv({ ...VALID_ENV, STOREFRONT_ROOT_DOMAIN: '' })).not.toThrow();
      expect(() => validateEnv({ ...VALID_ENV })).not.toThrow();
    });

    it.each(['https://midominio.com', 'midominio.com:3000', 'midominio.com/tiendas', 'mi dominio.com'])(
      'refuses %s, which could never match a hostname',
      (value) => {
        expect(() => validateEnv({ ...VALID_ENV, STOREFRONT_ROOT_DOMAIN: value })).toThrow(/STOREFRONT_ROOT_DOMAIN/);
      },
    );
  });
});
