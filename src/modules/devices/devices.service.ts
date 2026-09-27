import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { getScopedClient } from '../../prisma/tenant-context';
import { RegisterDeviceDto } from './dto';

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * See AuthService's identical `client` getter for why this matters even for
   * a single query: this endpoint requires a resolved tenant (TenantRequiredGuard),
   * so it's always wrapped in TenantScopeInterceptor's transaction, which
   * already holds the pool's only connection under the test suite's
   * connection_limit=1 — a second one via the raw client would deadlock
   * waiting for a connection this same request is holding.
   */
  private get client(): ReturnType<typeof getScopedClient> {
    return getScopedClient(this.prisma);
  }

  /**
   * Upserts by (userId, deviceId): re-registering the same device (a rotated
   * Expo push token, or the tenant it currently wants events for changing
   * after a switch-tenant) replaces the row in place rather than
   * accumulating stale ones for the same physical phone.
   */
  async register(userId: string, tenantId: string, dto: RegisterDeviceDto) {
    const device = await this.client.deviceToken.upsert({
      where: { userId_deviceId: { userId, deviceId: dto.deviceId } },
      update: {
        tenantId,
        token: dto.token,
        platform: dto.platform,
        lastSeenAt: new Date(),
        revokedAt: null,
      },
      create: {
        userId,
        tenantId,
        token: dto.token,
        platform: dto.platform,
        deviceId: dto.deviceId,
      },
    });
    return { id: device.id, registered: true };
  }

  /**
   * Soft-revokes by (userId, token) — scoped to the caller's own userId so
   * one user can never revoke another's device by guessing a token. A token
   * that doesn't match (already revoked, or never registered) is a silent
   * no-op: this is idempotent, not a lookup oracle.
   */
  async revoke(userId: string, token: string) {
    await this.client.deviceToken.updateMany({
      where: { userId, token, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  }
}
