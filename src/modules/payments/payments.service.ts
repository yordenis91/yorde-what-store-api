import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { StripeAdapter } from './adapters/stripe.adapter';
import { INVOICE_PDF_QUEUE } from '../../queue/queue.constants';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantsService: TenantsService,
    private readonly stripeAdapter: StripeAdapter,
    @InjectQueue(INVOICE_PDF_QUEUE) private readonly invoiceQueue: Queue,
  ) {}

  async createStripeCheckout(tenantId: string, orderId: string, urls: { successUrl: string; cancelUrl: string }) {
    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillmentMethod !== 'STRIPE') {
      throw new BadRequestException('Order is not configured for card payment');
    }

    const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'STRIPE');

    const result = await this.stripeAdapter.createCheckout(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        tenantId,
        currency: order.currency,
        grandTotal: Number(order.grandTotal),
        customerEmail: order.customerEmail,
        items: order.items.map((i) => ({
          productName: i.productName,
          variantName: i.variantName,
          unitPrice: Number(i.unitPrice),
          quantity: i.quantity,
        })),
      },
      credentials,
      urls,
    );

    await this.prisma.db.order.update({
      where: { id: order.id },
      data: { stripeCheckoutSessionId: result.providerReference },
    });

    return result;
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string) {
    let event: Stripe.Event;
    try {
      event = this.stripeAdapter.verifyAndParseWebhook(rawBody, signature);
    } catch (err) {
      this.logger.warn(`Stripe webhook signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const { tenantId, orderId } = session.metadata ?? {};
      if (!tenantId || !orderId) {
        this.logger.warn(`Stripe session ${session.id} missing tenantId/orderId metadata`);
        return { received: true };
      }

      await this.prisma.withTenant(tenantId, async (tx) => {
        const order = await tx.order.update({
          where: { id: orderId },
          data: {
            paymentStatus: 'PAID',
            status: 'CONFIRMED',
            stripePaymentIntentId: (session.payment_intent as string) ?? undefined,
          },
        });
        await this.invoiceQueue.add('generate-invoice', { tenantId, orderId: order.id });
      });
    }

    return { received: true };
  }
}
