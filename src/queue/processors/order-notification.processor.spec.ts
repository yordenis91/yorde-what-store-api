import type { Job } from 'bullmq';
import { OrderNotificationProcessor } from './order-notification.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { PushService } from '../../notifications/push.service';

const TENANT = { id: 'tenant-1', telegramBotToken: 'bot-token', telegramChatId: 'chat-1' };

function buildJob(overrides: Partial<{ name: string; tenantId: string; orderId: string; message: string }> = {}) {
  return {
    name: overrides.name ?? 'telegram-message',
    data: {
      tenantId: overrides.tenantId ?? TENANT.id,
      orderId: overrides.orderId ?? 'order-1',
      message: overrides.message ?? 'Thanks for your order!',
    },
  } as unknown as Job;
}

function buildProcessor(
  options: {
    tenant?: Record<string, unknown> | null;
    devices?: { token: string }[];
    telegramOk?: boolean;
  } = {},
) {
  const tenantFindUnique = jest.fn().mockResolvedValue(options.tenant !== undefined ? options.tenant : TENANT);
  const deviceTokenFindMany = jest.fn().mockResolvedValue(options.devices ?? []);
  const prisma = {
    tenant: { findUnique: tenantFindUnique },
    deviceToken: { findMany: deviceTokenFindMany },
  } as unknown as PrismaService;

  const send = jest.fn().mockResolvedValue(undefined);
  const pushService = { send } as unknown as PushService;

  global.fetch = jest.fn().mockResolvedValue({
    ok: options.telegramOk ?? true,
    text: () => Promise.resolve('error body'),
  }) as unknown as typeof fetch;

  return { processor: new OrderNotificationProcessor(prisma, pushService), send, deviceTokenFindMany };
}

describe('OrderNotificationProcessor', () => {
  it('ignores jobs that are not telegram-message', async () => {
    const { processor, send } = buildProcessor();
    await processor.process(buildJob({ name: 'something-else' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('skips (no throw) when the tenant has no Telegram bot configured', async () => {
    const { processor, send } = buildProcessor({
      tenant: { id: TENANT.id, telegramBotToken: null, telegramChatId: null },
    });
    await processor.process(buildJob());
    expect(send).not.toHaveBeenCalled();
  });

  it('throws when the Telegram API call fails, so BullMQ retries', async () => {
    const { processor } = buildProcessor({ telegramOk: false });
    await expect(processor.process(buildJob())).rejects.toThrow('Telegram sendMessage failed');
  });

  it('sends a push to every non-revoked device registered for the tenant after a successful Telegram send', async () => {
    const { processor, send, deviceTokenFindMany } = buildProcessor({
      devices: [{ token: 'expo-token-a' }, { token: 'expo-token-b' }],
    });

    await processor.process(buildJob({ orderId: 'order-42' }));

    expect(deviceTokenFindMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT.id, revokedAt: null },
      select: { token: true },
    });
    expect(send).toHaveBeenCalledWith(
      ['expo-token-a', 'expo-token-b'],
      expect.objectContaining({ data: { type: 'new-order', orderId: 'order-42' } }),
    );
  });

  it('does not call the push service when the tenant has no registered devices', async () => {
    const { processor, send } = buildProcessor({ devices: [] });
    await processor.process(buildJob());
    expect(send).not.toHaveBeenCalled();
  });

  it('a push failure does not fail the job (the Telegram send already succeeded)', async () => {
    const { processor, send } = buildProcessor({ devices: [{ token: 'expo-token-a' }] });
    send.mockRejectedValueOnce(new Error('push provider down'));
    await expect(processor.process(buildJob())).resolves.toBeUndefined();
  });
});
