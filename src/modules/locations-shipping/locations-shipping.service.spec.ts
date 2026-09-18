import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsShippingService } from './locations-shipping.service';

const TENANT_ID = 'tenant-1';
const LOCATION_ID = 'location-1';

function buildService(options: { location?: Record<string, unknown> | null; shippingCount?: number } = {}) {
  const location = options.location !== undefined ? options.location : { id: LOCATION_ID, tenantId: TENANT_ID };
  const findFirst = jest.fn().mockResolvedValue(location);
  const deleteLocation = jest.fn().mockResolvedValue({ id: LOCATION_ID });
  const count = jest.fn().mockResolvedValue(options.shippingCount ?? 0);

  const prisma = {
    db: {
      location: { findFirst, delete: deleteLocation },
      shipping: { count },
    },
  } as unknown as PrismaService;

  return { service: new LocationsShippingService(prisma), findFirst, deleteLocation, count };
}

describe('LocationsShippingService.removeLocation', () => {
  it('deletes the location when no shipping method references it', async () => {
    const { service, deleteLocation } = buildService({ shippingCount: 0 });

    const result = await service.removeLocation(TENANT_ID, LOCATION_ID);

    expect(deleteLocation).toHaveBeenCalledWith({ where: { id: LOCATION_ID } });
    expect(result).toEqual({ deleted: true });
  });

  it('blocks deletion with a ConflictException when shipping methods still reference it', async () => {
    const { service, deleteLocation, count } = buildService({ shippingCount: 3 });

    await expect(service.removeLocation(TENANT_ID, LOCATION_ID)).rejects.toThrow(ConflictException);
    expect(count).toHaveBeenCalledWith({ where: { tenantId: TENANT_ID, locationId: LOCATION_ID } });
    expect(deleteLocation).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for a location belonging to another tenant', async () => {
    const { service, deleteLocation } = buildService({ location: null });

    await expect(service.removeLocation(TENANT_ID, LOCATION_ID)).rejects.toThrow(NotFoundException);
    expect(deleteLocation).not.toHaveBeenCalled();
  });
});
