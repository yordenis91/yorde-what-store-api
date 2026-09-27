import { PrismaService } from '../../prisma/prisma.service';
import { DevicesService } from './devices.service';
import { DevicePlatform } from '@prisma/client';

function buildService() {
  const upsert = jest.fn().mockResolvedValue({ id: 'device-1' });
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = { deviceToken: { upsert, updateMany } } as unknown as PrismaService;
  return { service: new DevicesService(prisma), upsert, updateMany };
}

describe('DevicesService', () => {
  it('upserts by (userId, deviceId), clearing any prior revocation', async () => {
    const { service, upsert } = buildService();

    const result = await service.register('user-1', 'tenant-1', {
      token: 'expo-token',
      platform: DevicePlatform.IOS,
      deviceId: 'device-abc',
    });

    expect(result).toEqual({ id: 'device-1', registered: true });
    expect(upsert).toHaveBeenCalledWith({
      where: { userId_deviceId: { userId: 'user-1', deviceId: 'device-abc' } },
      update: {
        tenantId: 'tenant-1',
        token: 'expo-token',
        platform: DevicePlatform.IOS,
        lastSeenAt: expect.any(Date),
        revokedAt: null,
      },
      create: {
        userId: 'user-1',
        tenantId: 'tenant-1',
        token: 'expo-token',
        platform: DevicePlatform.IOS,
        deviceId: 'device-abc',
      },
    });
  });

  it("revokes scoped to the caller's own userId and token, and is idempotent", async () => {
    const { service, updateMany } = buildService();

    const result = await service.revoke('user-1', 'expo-token');

    expect(result).toEqual({ revoked: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: 'expo-token', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
