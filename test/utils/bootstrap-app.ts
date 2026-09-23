import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';

/**
 * Mirrors src/main.ts closely enough to matter for these tests: the global
 * prefix, the ValidationPipe, and cookie-parser (refresh-token flows read
 * their cookie via req.cookies). Helmet and Swagger are left out — neither
 * changes how a request is authorized or routed to Prisma.
 */
export async function bootstrapTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // Production uses Redis-backed throttler storage on purpose — it's what
    // makes rate limits correct across horizontally-scaled API replicas. In
    // tests that Redis instance is shared by every e2e spec file in the run,
    // so per-route counters (e.g. the 5/min on auth endpoints) would leak
    // across unrelated test files and fail later ones with 429s. Swapping in
    // the in-memory storage gives each test app its own isolated counters,
    // same as a single real process would have.
    .overrideProvider(ThrottlerStorage)
    .useClass(ThrottlerStorageService)
    .compile();
  const app = moduleRef.createNestApplication();

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  await app.init();
  return app;
}
