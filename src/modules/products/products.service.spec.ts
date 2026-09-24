import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { CategoryTemplatesService } from '../category-templates/category-templates.service';
import { deleteUploadedFile } from '../uploads/uploads.util';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto';

jest.mock('../uploads/uploads.util', () => ({ deleteUploadedFile: jest.fn() }));

const TENANT_ID = 'tenant-1';

function buildService(options: { productCount?: number; plan?: { maxProducts: number } | null }) {
  const create = jest.fn().mockResolvedValue({ id: 'new-product' });
  const count = jest.fn().mockResolvedValue(options.productCount ?? 0);
  const executeRaw = jest.fn().mockResolvedValue(undefined);

  const prisma = { db: { product: { create, count }, $executeRaw: executeRaw } } as unknown as PrismaService;
  const plansService = {
    currentSubscription: jest.fn().mockResolvedValue(options.plan ? { plan: options.plan } : null),
  } as unknown as PlansService;
  const categoryTemplatesService = {} as CategoryTemplatesService;

  const service = new ProductsService(prisma, categoryTemplatesService, plansService);
  return { service, create, count, executeRaw };
}

const PRODUCT_ID = 'product-1';

function buildImageService(options: { images?: { id: string; url?: string }[] }) {
  const images = options.images ?? [{ id: 'img-1' }, { id: 'img-2' }, { id: 'img-3' }];

  const findFirst = jest.fn().mockResolvedValue({ id: PRODUCT_ID, tenantId: TENANT_ID });
  const findMany = jest.fn().mockResolvedValue(images);
  const update = jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
  const aggregate = jest.fn().mockResolvedValue({ _max: { sortOrder: images.length - 1 } });
  const create = jest.fn().mockResolvedValue({ id: 'new-image' });
  const imageFindFirst = jest
    .fn()
    .mockImplementation(({ where }) =>
      Promise.resolve(
        images.find((img) => img.id === where.id && (!where.productId || where.productId === PRODUCT_ID)) ?? null,
      ),
    );
  const deleteImage = jest.fn().mockResolvedValue({ id: 'deleted' });

  const prisma = {
    db: {
      product: { findFirst },
      productImage: {
        findMany,
        findFirst: imageFindFirst,
        update,
        aggregate,
        create,
        delete: deleteImage,
        updateMany: jest.fn(),
      },
    },
  } as unknown as PrismaService;
  const service = new ProductsService(prisma, {} as CategoryTemplatesService, {} as PlansService);
  return { service, findMany, update, aggregate, create, imageFindFirst, deleteImage };
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

  it('takes a per-tenant advisory lock before counting, to close the count-then-insert race', async () => {
    const { service, executeRaw } = buildService({ productCount: 5, plan: { maxProducts: 20 } });
    await service.create(TENANT_ID, DTO);
    expect(executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('pg_advisory_xact_lock')]),
      TENANT_ID,
    );
  });
});

describe('ProductsService.addImage — sortOrder', () => {
  it('appends a new image after the current max sortOrder instead of defaulting to 0', async () => {
    const { service, create } = buildImageService({ images: [{ id: 'img-1' }, { id: 'img-2' }] });
    await service.addImage(TENANT_ID, PRODUCT_ID, { url: '/uploads/new.webp' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sortOrder: 2 }) }));
  });

  it('starts at 0 for a product with no images yet', async () => {
    const { service, create, aggregate } = buildImageService({ images: [] });
    aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    await service.addImage(TENANT_ID, PRODUCT_ID, { url: '/uploads/first.webp' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sortOrder: 0 }) }));
  });
});

describe('ProductsService.removeImage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the DB row and cleans up the underlying file', async () => {
    const { service, deleteImage, imageFindFirst } = buildImageService({
      images: [{ id: 'img-1', url: '/uploads/tenant-1/img-1.webp' }],
    });

    await service.removeImage(TENANT_ID, PRODUCT_ID, 'img-1');

    expect(imageFindFirst).toHaveBeenCalledWith({ where: { id: 'img-1', productId: PRODUCT_ID } });
    expect(deleteImage).toHaveBeenCalledWith({ where: { id: 'img-1' } });
    expect(deleteUploadedFile).toHaveBeenCalledWith('/uploads/tenant-1/img-1.webp');
  });

  it("404s on an image id that isn't this product's, without deleting anything", async () => {
    const { service, deleteImage } = buildImageService({ images: [{ id: 'img-1', url: '/uploads/img-1.webp' }] });

    await expect(service.removeImage(TENANT_ID, PRODUCT_ID, 'someone-elses-image')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(deleteImage).not.toHaveBeenCalled();
    expect(deleteUploadedFile).not.toHaveBeenCalled();
  });
});

describe('ProductsService.reorderImages', () => {
  it("sets sortOrder to each image id's position in the given order", async () => {
    const { service, update } = buildImageService({ images: [{ id: 'img-1' }, { id: 'img-2' }, { id: 'img-3' }] });

    await service.reorderImages(TENANT_ID, PRODUCT_ID, { imageIds: ['img-3', 'img-1', 'img-2'] });

    expect(update).toHaveBeenCalledWith({ where: { id: 'img-3' }, data: { sortOrder: 0 } });
    expect(update).toHaveBeenCalledWith({ where: { id: 'img-1' }, data: { sortOrder: 1 } });
    expect(update).toHaveBeenCalledWith({ where: { id: 'img-2' }, data: { sortOrder: 2 } });
  });

  it("rejects a payload missing one of the product's current images", async () => {
    const { service, update } = buildImageService({ images: [{ id: 'img-1' }, { id: 'img-2' }, { id: 'img-3' }] });

    await expect(service.reorderImages(TENANT_ID, PRODUCT_ID, { imageIds: ['img-1', 'img-2'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a payload containing an id that is not one of this product's images", async () => {
    const { service, update } = buildImageService({ images: [{ id: 'img-1' }, { id: 'img-2' }] });

    await expect(
      service.reorderImages(TENANT_ID, PRODUCT_ID, { imageIds: ['img-1', 'img-2', 'someone-elses-image'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });
});
