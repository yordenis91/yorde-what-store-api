import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLocationDto, UpdateLocationDto, CreateShippingDto, UpdateShippingDto } from './dto';

@Injectable()
export class LocationsShippingService {
  constructor(private readonly prisma: PrismaService) {}

  listLocations(tenantId: string) {
    return this.prisma.db.location.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
  }

  createLocation(tenantId: string, dto: CreateLocationDto) {
    return this.prisma.db.location.create({ data: { tenantId, ...dto } });
  }

  async updateLocation(tenantId: string, id: string, dto: UpdateLocationDto) {
    await this.ensureLocation(tenantId, id);
    return this.prisma.db.location.update({ where: { id }, data: dto });
  }

  async removeLocation(tenantId: string, id: string) {
    await this.ensureLocation(tenantId, id);
    await this.prisma.db.location.delete({ where: { id } });
    return { deleted: true };
  }

  listShippings(tenantId: string, { activeOnly = false }: { activeOnly?: boolean } = {}) {
    return this.prisma.db.shipping.findMany({
      where: { tenantId, ...(activeOnly ? { isActive: true } : {}) },
      include: { location: true },
      orderBy: { name: 'asc' },
    });
  }

  createShipping(tenantId: string, dto: CreateShippingDto) {
    return this.prisma.db.shipping.create({ data: { tenantId, ...dto, isActive: dto.isActive ?? true } });
  }

  async updateShipping(tenantId: string, id: string, dto: UpdateShippingDto) {
    await this.ensureShipping(tenantId, id);
    return this.prisma.db.shipping.update({ where: { id }, data: dto });
  }

  async removeShipping(tenantId: string, id: string) {
    await this.ensureShipping(tenantId, id);
    await this.prisma.db.shipping.delete({ where: { id } });
    return { deleted: true };
  }

  private async ensureLocation(tenantId: string, id: string) {
    const location = await this.prisma.db.location.findFirst({ where: { id, tenantId } });
    if (!location) throw new NotFoundException('Location not found');
  }

  private async ensureShipping(tenantId: string, id: string) {
    const shipping = await this.prisma.db.shipping.findFirst({ where: { id, tenantId } });
    if (!shipping) throw new NotFoundException('Shipping method not found');
  }
}
