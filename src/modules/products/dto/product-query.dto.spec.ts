import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { ProductQueryDto } from './product-query.dto';

/**
 * Regression: the global ValidationPipe runs with `enableImplicitConversion:
 * true` (main.ts), which casts every query-string value to its reflected
 * type before any `@Transform` sees it — and `Boolean('false')` is `true`.
 * The original `@Transform(({ value }) => value === 'true' || value ===
 * true)` read that already-mangled value, so `?isActive=false` and
 * `?isActive=true` both ended up `true`: the admin's product list "Inactive"
 * filter silently showed active products instead. Reported live against the
 * real API — GET /products?isActive=false returned only active products.
 */
describe('ProductQueryDto.isActive', () => {
  function transform(raw: Record<string, unknown>) {
    return plainToInstance(ProductQueryDto, raw, { enableImplicitConversion: true }).isActive;
  }

  it('parses ?isActive=true as true', () => {
    expect(transform({ isActive: 'true' })).toBe(true);
  });

  it('parses ?isActive=false as false, not true', () => {
    expect(transform({ isActive: 'false' })).toBe(false);
  });

  it('leaves isActive undefined when the query param is absent', () => {
    expect(transform({})).toBeUndefined();
  });
});
