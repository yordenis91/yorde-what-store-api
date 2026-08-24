import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';

/**
 * Mirrors src/main.ts closely enough to matter for these tests: the global
 * prefix, the ValidationPipe, and cookie-parser (refresh-token flows read
 * their cookie via req.cookies). Helmet and Swagger are left out — neither
 * changes how a request is authorized or routed to Prisma.
 */
export async function bootstrapTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.init();
  return app;
}
