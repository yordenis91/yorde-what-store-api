import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from './prisma/prisma.service';

/**
 * A dedicated connection, not the one BullMQ/Throttler already hold — this one
 * is allowed to sit idle or briefly fail without disturbing queues or rate
 * limiting, and its own state never blocks retrying a health check.
 */
@Injectable()
export class AppService implements OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.redis = new Redis({
      host: config.get<string>('redis.host'),
      port: config.get<number>('redis.port'),
      password: config.get<string>('redis.password'),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: () => null, // one attempt per check; the health check itself is the retry loop
    });
    this.redis.on('error', (err) => this.logger.warn(`Health-check Redis connection: ${err.message}`));
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }

  /**
   * Always resolves with HTTP 200 (the controller never throws) — this is
   * also EasyPanel's container healthcheck, and a false restart over a
   * one-off Redis blip is worse than a stale-for-a-few-seconds `degraded`
   * flag. Callers that care about the dependency state read `checks`.
   */
  async health() {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      status: database && redis ? ('ok' as const) : ('degraded' as const),
      checks: { database, redis },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect();
      const reply = await this.redis.ping();
      return reply === 'PONG';
    } catch {
      return false;
    }
  }
}
