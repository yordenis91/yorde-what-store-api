import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface OrderEventPayload {
  id: string;
  orderNumber: string;
  customerName: string;
  grandTotal: number;
  currency: string;
  status: string;
}

export interface OrderEvent {
  type: 'order.created' | 'order.status_updated';
  order: OrderEventPayload;
}

/**
 * In-process pub/sub, one Subject per tenant — enough for a single API
 * instance (this app's current deployment). It is a live nudge for whoever
 * has the dashboard open right now, not a record of what happened: an order
 * created while nobody is subscribed is simply not announced, exactly like a
 * doorbell rung to an empty house. The order itself is safely in Postgres
 * either way, and the dashboard's own list is what staff sees on open or
 * refresh regardless of whether this fired.
 *
 * If this ever runs as more than one replica, a tenant's staff could connect
 * to different instances and miss each other's events — move `emit`/`stream`
 * to Redis pub/sub at that point (the connection is already provisioned for
 * BullMQ) rather than before.
 */
@Injectable()
export class OrderEventsService {
  private readonly streams = new Map<string, Subject<OrderEvent>>();

  stream(tenantId: string) {
    return this.streamFor(tenantId).asObservable();
  }

  emit(tenantId: string, event: OrderEvent) {
    this.streamFor(tenantId).next(event);
  }

  private streamFor(tenantId: string): Subject<OrderEvent> {
    let subject = this.streams.get(tenantId);
    if (!subject) {
      subject = new Subject<OrderEvent>();
      this.streams.set(tenantId, subject);
    }
    return subject;
  }
}
