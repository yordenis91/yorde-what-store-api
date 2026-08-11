import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../../prisma/prisma.service';
import { INVOICE_PDF_QUEUE } from '../queue.constants';

@Processor(INVOICE_PDF_QUEUE)
export class InvoicePdfProcessor extends WorkerHost {
  private readonly logger = new Logger(InvoicePdfProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<{ tenantId: string; orderId: string }>): Promise<void> {
    const { tenantId, orderId } = job.data;

    await this.prisma.withTenant(tenantId, async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      if (!order) return;

      const buffer = await this.renderInvoice(order);
      this.logger.log(`Generated invoice for order ${order.orderNumber} (${buffer.length} bytes)`);
      // TODO: persist `buffer` to object storage and store the URL on the order.
    });
  }

  private renderInvoice(order: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text(`Invoice ${order.orderNumber}`, { align: 'left' });
      doc.moveDown();
      doc.fontSize(11).text(`Customer: ${order.customerName}`);
      doc.text(`Date: ${new Date(order.createdAt).toLocaleDateString()}`);
      doc.moveDown();

      for (const item of order.items) {
        doc.text(`${item.quantity} x ${item.productName}${item.variantName ? ` (${item.variantName})` : ''} — ${item.lineTotal}`);
      }

      doc.moveDown();
      doc.fontSize(13).text(`Total: ${order.currency} ${order.grandTotal}`, { align: 'right' });
      doc.end();
    });
  }
}
