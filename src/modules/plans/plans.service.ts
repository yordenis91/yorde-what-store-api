import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePlanDto, UpdatePlanDto } from './dto';

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  listActive() {
    return this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { price: 'asc' } });
  }

  listAll() {
    return this.prisma.plan.findMany({ orderBy: { price: 'asc' } });
  }

  create(dto: CreatePlanDto) {
    return this.prisma.plan.create({ data: dto as any });
  }

  async update(id: string, dto: UpdatePlanDto) {
    await this.ensureExists(id);
    return this.prisma.plan.update({ where: { id }, data: dto as any });
  }

  async remove(id: string) {
    await this.ensureExists(id);
    await this.prisma.plan.update({ where: { id }, data: { isActive: false } });
    return { deactivated: true };
  }

  async subscribe(tenantId: string, planId: string) {
    const plan = await this.prisma.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) throw new NotFoundException('Plan not found');

    const expiresAt = this.computeExpiry(plan.duration);
    const existing = await this.prisma.subscription.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return this.prisma.subscription.update({
        where: { id: existing.id },
        data: { planId, expiresAt, status: 'ACTIVE' },
      });
    }
    return this.prisma.subscription.create({ data: { tenantId, planId, expiresAt, status: 'ACTIVE' } });
  }

  async currentSubscription(tenantId: string) {
    return this.prisma.subscription.findFirst({
      where: { tenantId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async requestUpgrade(tenantId: string, planId: string) {
    const plan = await this.prisma.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) throw new NotFoundException('Plan not found');

    const current = await this.currentSubscription(tenantId);
    if (!current) throw new BadRequestException('No active subscription to upgrade');

    return this.prisma.subscription.update({
      where: { id: current.id },
      data: { requestedPlanId: planId, status: 'PENDING_UPGRADE' },
    });
  }

  async approveUpgrade(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    if (!subscription.requestedPlanId) throw new BadRequestException('No pending upgrade request');

    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: subscription.requestedPlanId } });
    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        planId: plan.id,
        requestedPlanId: null,
        status: 'ACTIVE',
        expiresAt: this.computeExpiry(plan.duration),
      },
    });
  }

  private computeExpiry(duration: string): Date | null {
    const now = new Date();
    if (duration === 'MONTHLY') return new Date(now.setMonth(now.getMonth() + 1));
    if (duration === 'YEARLY') return new Date(now.setFullYear(now.getFullYear() + 1));
    return null;
  }

  private async ensureExists(id: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
  }
}
