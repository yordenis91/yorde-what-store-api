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
});
