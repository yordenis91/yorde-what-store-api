import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CategoryTemplatesService } from './category-templates.service';

interface FakeTemplate {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
}

/** In-memory store, so slug-uniqueness and parent-lookup checks run against real state instead of canned mocks. */
function createPrismaDouble(seed: FakeTemplate[] = []) {
  const rows = new Map(seed.map((t) => [t.id, t]));
  let nextId = 1;

  const categoryTemplate = {
    findMany: jest.fn(async (args: { where?: { isActive?: boolean } } = {}) =>
      [...rows.values()]
        .filter((t) => args.where?.isActive === undefined || t.isActive === args.where.isActive)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    ),
    findUnique: jest.fn(async ({ where }: { where: { id?: string; slug?: string } }) => {
      if (where.id) return rows.get(where.id) ?? null;
      return [...rows.values()].find((t) => t.slug === where.slug) ?? null;
    }),
    findFirst: jest.fn(async ({ where }: { where: { isActive?: boolean } }) =>
      [...rows.values()].find((t) => (where.isActive === undefined ? true : t.isActive === where.isActive)) ?? null,
    ),
    create: jest.fn(async ({ data }: { data: Omit<FakeTemplate, 'id' | 'isActive'> & { isActive?: boolean } }) => {
      const row: FakeTemplate = { id: `t${nextId++}`, isActive: true, ...data };
      rows.set(row.id, row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeTemplate> }) => {
      const row = rows.get(where.id)!;
      const updated = { ...row, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
      rows.set(where.id, updated);
      return updated;
    }),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      rows.delete(where.id);
      return row;
    }),
  };

  return { db: { categoryTemplate }, categoryTemplate, rows };
}

async function buildService(double: ReturnType<typeof createPrismaDouble>) {
  const moduleRef = await Test.createTestingModule({
    providers: [CategoryTemplatesService, { provide: PrismaService, useValue: double }],
  }).compile();
  return moduleRef.get(CategoryTemplatesService);
}

describe('CategoryTemplatesService', () => {
  it('derives a URL-safe slug from an accented name', async () => {
    const service = await buildService(createPrismaDouble());

    const created = await service.create({ name: 'Electrónica y Cómputo' });

    expect(created.slug).toBe('electronica-y-computo');
  });

  it('disambiguates a slug collision instead of erroring', async () => {
    const service = await buildService(createPrismaDouble());

    const first = await service.create({ name: 'Hogar' });
    const second = await service.create({ name: 'Hogar' });

    expect(first.slug).toBe('hogar');
    expect(second.slug).toBe('hogar-2');
  });

  it('rejects a parentId that does not exist', async () => {
    const service = await buildService(createPrismaDouble());

    await expect(service.create({ name: 'Smartphones', parentId: 'missing' })).rejects.toThrow(NotFoundException);
  });

  it('creates a child under a real parent', async () => {
    const service = await buildService(createPrismaDouble());
    const parent = await service.create({ name: 'Electrónica' });

    const child = await service.create({ name: 'Celulares', parentId: parent.id });

    expect(child.parentId).toBe(parent.id);
  });

  it('rejects a category becoming its own parent', async () => {
    const double = createPrismaDouble([{ id: 't1', name: 'Ropa', slug: 'ropa', parentId: null, sortOrder: 0, isActive: true }]);
    const service = await buildService(double);

    await expect(service.update('t1', { parentId: 't1' })).rejects.toThrow(BadRequestException);
  });

  it('404s updating or deleting a template that does not exist', async () => {
    const service = await buildService(createPrismaDouble());

    await expect(service.update('missing', { name: 'x' })).rejects.toThrow(NotFoundException);
    await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
  });

  it('lists only active templates for the tenant-facing catalog', async () => {
    const double = createPrismaDouble([
      { id: 't1', name: 'Ropa', slug: 'ropa', parentId: null, sortOrder: 0, isActive: true },
      { id: 't2', name: 'Descontinuado', slug: 'descontinuado', parentId: null, sortOrder: 0, isActive: false },
    ]);
    const service = await buildService(double);

    const active = await service.listActive();

    expect(active.map((t) => t.id)).toEqual(['t1']);
  });
});
