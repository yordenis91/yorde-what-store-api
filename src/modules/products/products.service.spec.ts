import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { CategoryTemplatesService } from '../category-templates/category-templates.service';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto';

const TENANT_ID = 'tenant-1';

function buildService(options: { productCount?: number; plan?: { maxProducts: number } | null }) {
  const create = jest.fn().mockResolvedValue({ id: 'new-product' });
  const count = jest.fn().mockResolvedValue(options.productCount ?? 0);

  const prisma = { db: { product: { create, count } } } as unknown as PrismaService;
  const plansService = {
    currentSubscription: jest.fn().mockResolvedValue(options.plan ? { plan: options.plan } : null),
  } as unknown as PlansService;
  const categoryTemplatesService = {} as CategoryTemplatesService;

  const service = new ProductsService(prisma, categoryTemplatesService, plansService);
  return { service, create, count };
}

const DTO: CreateProductDto = { name: 'Widget', price: 10 } as CreateProductDto;

/**
 * The plan's own maxProducts is defined on the Plan/Subscription models but was
 * never checked anywhere — a Free-plan tenant could load an unlimited catalog.
 * These pin the enforcement added in ProductsService.create.
 */
describe('ProductsService.create — plan product limit', () => {
  it('allows creation when under the plan limit', async () => {
    const { service, create } = buildService({ productCount: 19, plan: { maxProducts: 20 } });
    await service.create(TENANT_ID, DTO);
    expect(create).toHaveBeenCalled();
  });

  it('rejects creation once the plan limit is reached', async () => {
    const { service, create } = buildService({ productCount: 20, plan: { maxProducts: 20 } });
    await expect(service.create(TENANT_ID, DTO)).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it('never blocks an unlimited (-1) plan', async () => {
    const { service, create } = buildService({ productCount: 100_000, plan: { maxProducts: -1 } });
    await service.create(TENANT_ID, DTO);
    expect(create).toHaveBeenCalled();
  });

  it('falls back to the Free plan limit when the tenant has no subscription row', async () => {
    const { service, create } = buildService({ productCount: 20, plan: null });
    await expect(service.create(TENANT_ID, DTO)).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });
});
