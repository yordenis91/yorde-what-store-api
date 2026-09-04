import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  // Every upload gets a fresh randomUUID() filename (UploadsController) — a
  // URL is never reused for different content, so it's safe to cache
  // forever. Editing a product's photo uploads a new file under a new URL
  // rather than overwriting this one.
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads',
    maxAge: '1y',
    immutable: true,
  });

  const config = app.get(ConfigService);
  const prefix = config.get<string>('app.prefix') ?? 'api/v1';
  const corsOrigins = config.get<string[]>('app.corsOrigins') ?? [];

  app.setGlobalPrefix(prefix);
  app.use(helmet());
  // Every tenant-scoped GET (storefront and admin alike) resolves its tenant
  // from the X-Tenant-ID header or JWT, not the URL — so two different
  // tenants can request the exact same path (e.g. GET /storefront/products).
  // Browsers key their HTTP cache on the URL, not on custom headers, so
  // without this a visitor could be served another tenant's cached response
  // for an identical-looking request. A route that genuinely wants caching
  // (uploads, preview) sets its own Cache-Control later in the pipeline,
  // which overrides this default.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cookieParser());
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Yorde What Store API')
    .setDescription('Multitenant ecommerce SAAS API')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-Tenant-ID', in: 'header' }, 'tenant')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${prefix}/docs`, app, document);

  const port = config.get<number>('app.port') ?? 3000;
  await app.listen(port);
}

bootstrap();
