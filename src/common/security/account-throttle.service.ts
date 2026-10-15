import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Failed-attempt lockout per ACCOUNT. The route throttles are per client IP, so someone rotating IPs
 * (or a botnet) can guess one account's password or TOTP code without limit. This counts failures
 * against the account itself, whatever the source address, and stops accepting guesses once the
 * budget is spent. A success clears the counter, so ordinary users never see it.
 *
 * Fails open if Redis is unreachable: the IP throttle (which needs the same Redis) is the other
 * layer, and locking everyone out because a counter could not be read is the worse failure.
 */
@Injectable()
export class AccountThrottleService implements OnModuleDestroy {
  private readonly logger = new Logger(AccountThrottleService.name);
  private redis: Redis | null = null;

  private client(): Redis {
    this.redis ??= new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    return this.redis;
  }

  /** Hashed so an email address never sits in a Redis key. */
  private key(scope: string, id: string): string {
    return `acct-throttle:${scope}:${createHash('sha256').update(id.toLowerCase()).digest('hex').slice(0, 32)}`;
  }

  /** Throws 429 when `limit` failures have already been recorded inside the window. */
  async assertNotLocked(scope: string, id: string, limit: number): Promise<void> {
    try {
      const failures = Number((await this.client().get(this.key(scope, id))) ?? 0);
      if (failures >= limit) {
        throw new HttpException('Too many failed attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(`Account throttle unavailable (${(err as Error).message}); not enforcing`);
    }
  }

  async recordFailure(scope: string, id: string, windowSeconds: number): Promise<void> {
    try {
      const key = this.key(scope, id);
      const failures = await this.client().incr(key);
      if (failures === 1) await this.client().expire(key, windowSeconds);
    } catch (err) {
      this.logger.warn(`Account throttle unavailable (${(err as Error).message}); failure not recorded`);
    }
  }

  async clear(scope: string, id: string): Promise<void> {
    try {
      await this.client().del(this.key(scope, id));
    } catch {
      // Best effort — the counter expires on its own.
    }
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }
}
