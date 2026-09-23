/**
 * `enabled` is module-level state (set once at boot by initSentry), so each
 * test gets a fresh module instance via jest.resetModules() — otherwise a
 * test that calls initSentry() would leak "enabled" into every test after it.
 */
describe('sentry', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('stays disabled and every call no-ops when SENTRY_DSN is unset', () => {
    delete process.env.SENTRY_DSN;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- needs a fresh module instance per test, see file doc comment above
    const sentryModule = require('@sentry/node');
    const initSpy = jest.spyOn(sentryModule, 'init');
    const captureSpy = jest.spyOn(sentryModule, 'captureException');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initSentry, isSentryEnabled, captureException } = require('./sentry');
    initSentry();
    captureException(new Error('boom'));

    expect(isSentryEnabled()).toBe(false);
    expect(initSpy).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('initializes and forwards exceptions once SENTRY_DSN is set', () => {
    process.env.SENTRY_DSN = 'https://public@sentry.example.com/1';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sentryModule = require('@sentry/node');
    const initSpy = jest.spyOn(sentryModule, 'init').mockImplementation(() => undefined);
    const captureSpy = jest.spyOn(sentryModule, 'captureException').mockImplementation(() => 'event-id');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initSentry, isSentryEnabled, captureException } = require('./sentry');
    initSentry();
    const error = new Error('boom');
    captureException(error, { jobId: '1' });

    expect(isSentryEnabled()).toBe(true);
    expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({ dsn: process.env.SENTRY_DSN }));
    expect(captureSpy).toHaveBeenCalledWith(error, { extra: { jobId: '1' } });
  });

  it('does nothing when captureException is called before initSentry', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sentryModule = require('@sentry/node');
    const captureSpy = jest.spyOn(sentryModule, 'captureException');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { captureException, isSentryEnabled } = require('./sentry');
    captureException(new Error('too early'));

    expect(isSentryEnabled()).toBe(false);
    expect(captureSpy).not.toHaveBeenCalled();
  });
});
