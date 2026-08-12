import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginatedResult, PaginationDto } from '../../common/dto/pagination.dto';
import { applyCouponDiscount, round2 } from '../orders/pricing.util';
import { CreateCouponDto, UpdateCouponDto } from './dto';

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateCouponDto) {
    return this.prisma.db.coupon.create({
      data: {
        tenantId,
        code: dto.code.toUpperCase(),
        name: dto.name,
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        usageLimit: dto.usageLimit,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async findAll(tenantId: string, pagination: PaginationDto): Promise<PaginatedResult<any>> {
    const where = {
      tenantId,
      ...(pagination.search ? { code: { contains: pagination.search, mode: 'insensitive' as const } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.coupon.findMany({
        where,
        skip: pagination.skip,
        take: pagination.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.db.coupon.count({ where }),
    ]);
    return {
      items,
      meta: { page: pagination.page, limit: pagination.limit, total, totalPages: Math.ceil(total / pagination.limit) },
    };
  }

  async findOne(tenantId: string, id: string) {
    const coupon = await this.prisma.db.coupon.findFirst({ where: { id, tenantId } });
    if (!coupon) throw new NotFoundException('Coupon not found');
    return coupon;
  }

  async update(tenantId: string, id: string, dto: UpdateCouponDto) {
    await this.findOne(tenantId, id);
    return this.prisma.db.coupon.update({
      where: { id },
      data: {
        ...dto,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    await this.prisma.db.coupon.update({ where: { id }, data: { isActive: false } });
    return { deactivated: true };
  }

  async validate(tenantId: string, code: string, subtotal: number) {
    const coupon = await this.prisma.db.coupon.findFirst({
      where: { tenantId, code: code.toUpperCase(), isActive: true },
    });
    if (!coupon) throw new BadRequestException('Invalid or inactive coupon');
    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      throw new BadRequestException('Coupon expired');
    }
    if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit) {
      throw new BadRequestException('Coupon usage limit reached');
    }

    const discount = applyCouponDiscount(subtotal, coupon.discountType, Number(coupon.discountValue));
    return {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: Number(coupon.discountValue),
      discountAmount: discount,
      total: round2(subtotal - discount),
    };
  }
}
