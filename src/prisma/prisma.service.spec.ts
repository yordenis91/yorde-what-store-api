import { PrismaService } from './prisma.service';

function build(role: { rolname: string; rolsuper: boolean; rolbypassrls: boolean } | undefined) {
  const service = new PrismaService();
  (service as any).$queryRaw = jest.fn().mockResolvedValue(role ? [role] : []);
  return service;
}

describe('PrismaService.assertRestrictedDatabaseRole', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('accepts a plain role', async () => {
    process.env.NODE_ENV = 'production';
    await expect(build({ rolname: 'app', rolsuper: false, rolbypassrls: false }).assertRestrictedDatabaseRole()).resolves.toBeUndefined();
  });

  it('refuses a superuser in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_PRIVILEGED_DB_ROLE;
    await expect(build({ rolname: 'postgres', rolsuper: true, rolbypassrls: true }).assertRestrictedDatabaseRole()).rejects.toThrow(/SUPERUSER/);
  });

  it('refuses a BYPASSRLS role in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_PRIVILEGED_DB_ROLE;
    await expect(build({ rolname: 'app', rolsuper: false, rolbypassrls: true }).assertRestrictedDatabaseRole()).rejects.toThrow(/BYPASSRLS/);
  });

  it('only warns outside production, and when explicitly allowed', async () => {
    process.env.NODE_ENV = 'development';
    await expect(build({ rolname: 'postgres', rolsuper: true, rolbypassrls: true }).assertRestrictedDatabaseRole()).resolves.toBeUndefined();
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_PRIVILEGED_DB_ROLE = 'true';
    await expect(build({ rolname: 'postgres', rolsuper: true, rolbypassrls: true }).assertRestrictedDatabaseRole()).resolves.toBeUndefined();
  });
});
