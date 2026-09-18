import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { PlatformProductsService } from './platform-products.service';
import { PlatformProductQueryDto } from './dto';

function buildQuery(overrides: Partial<PlatformProductQueryDto> = {}): PlatformProductQueryDto {
  return Object.assign(new PaginationDto(), { page: 1, limit: 20 }, overrides) as PlatformProductQueryDto;
}

function buildService(overrides: {
  products?: Record<string, unknown>[];
  total?: number;
  existing?: Record<string, unknown> | null;
}) {
  const findMany = jest.fn().mockResolvedValue(overrides.products ?? []);
  const count = jest.fn().mockResolvedValue(overrides.total ?? 0);
  const existing = overrides.existing !== undefined ? overrides.existing : { id: 'product-1' };
  const findUnique = jest.fn().mockResolvedValue(existing);
  const update = jest
    .fn()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'product-1', tenantId: 'tenant-1', ...data }),
    );

  const withRlsBypass = jest
    .fn()
    .mockImplementation((work: (tx: unknown) => Promise<unknown>) =>
      work({ product: { findMany, count, findUnique, update } }),
    );

  const prisma = { withRlsBypass } as unknown as PrismaService;
  return { service: new PlatformProductsService(prisma), findMany, count, findUnique, update };
}

describe('PlatformProductsService', () => {
  it('lists products across every tenant, going through withRlsBypass', async () => {
    const { service, findMany } = buildService({
      products: [{ id: 'p1', tenantId: 't1', name: 'Widget' }],
      total: 1,
    });

    const result = await service.list(buildQuery());

    expect(findMany).toHaveBeenCalled();
    expect(result.items).toEqual([{ id: 'p1', tenantId: 't1', name: 'Widget' }]);
    expect(result.meta.total).toBe(1);
  });

  it('filters by tenantId, isActive and isPublished', async () => {
    const { service, findMany } = buildService({});

    await service.list(buildQuery({ tenantId: 'tenant-42', isActive: false, isPublished: true }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-42', isActive: false, isPublished: true }),
      }),
    );
  });

  it('searches by name or SKU', async () => {
    const { service, findMany } = buildService({});

    await service.list(buildQuery({ search: 'widget' }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { name: { contains: 'widget', mode: 'insensitive' } },
            { sku: { contains: 'widget', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('moderate() toggles isActive and returns the product with its tenantId', async () => {
    const { service, update } = buildService({});

    const result = await service.moderate('product-1', { isActive: false });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { isActive: false } }));
    expect(result).toEqual(expect.objectContaining({ id: 'product-1', tenantId: 'tenant-1', isActive: false }));
  });

  it('moderate() throws NotFoundException for a product that does not exist', async () => {
    const { service } = buildService({ existing: null });

    await expect(service.moderate('missing', { isActive: false })).rejects.toThrow(NotFoundException);
  });
});
