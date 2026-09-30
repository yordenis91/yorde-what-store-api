import { Injectable, Logger } from '@nestjs/common';

export interface PushNotificationPayload {
  title: string;
  body: string;
  /** Arbitrary payload the client can read on tap — e.g. { type: 'new-order', orderId }. */
  data?: Record<string, unknown>;
}

/**
 * Provider-agnostic push delivery. `send` fans the same notification out to
 * every token given — the caller (order-notification.processor.ts, so far)
 * is responsible for resolving which DeviceToken rows it means to reach
 * (typically "every non-revoked device for this tenant"); this interface
 * doesn't know about tenants, orders or anything else — only how to deliver.
 * Swapping in a real provider (Expo push API, FCM, APNs) later means writing
 * one more class against this interface and changing PUSH_SERVICE's
 * `useClass` in NotificationsModule — nothing else in the app changes.
 */
export interface PushService {
  send(deviceTokens: string[], payload: PushNotificationPayload): Promise<void>;
}

/** DI token — inject with `@Inject(PUSH_SERVICE) private readonly pushService: PushService`. */
export const PUSH_SERVICE = Symbol('PUSH_SERVICE');

/**
 * Fase 1 implementation: logs what it would have sent and does nothing else.
 * Real delivery (FCM/APNs, most likely via the Expo push API so both
 * platforms go through one HTTP call) is a deliberate post-MVP follow-up —
 * see the mobile repo's README "Open backend questions".
 */
@Injectable()
export class NoOpPushService implements PushService {
  private readonly logger = new Logger(NoOpPushService.name);

  async send(deviceTokens: string[], payload: PushNotificationPayload): Promise<void> {
    if (deviceTokens.length === 0) return;
    this.logger.log(`[push:no-op] would send "${payload.title}" to ${deviceTokens.length} device(s): ${payload.body}`);
  }
}
