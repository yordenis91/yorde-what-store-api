import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ScheduleModule } from '@nestjs/schedule';
import { WinstonModule } from 'nest-winston';
import Redis from 'ioredis';

import {
  appConfig,
  jwtConfig,
  jwtCustomerConfig,
  mobileAuthConfig,
  redisConfig,
  stripeConfig,
  mercadoPagoConfig,
  paypalConfig,
  digitalConfig,
  mailConfig,
  totpConfig,
  securityConfig,
  backupConfig,
  platformConfig,
} from './config';
import { validateEnv } from './config/validate-env';
import { AccountThrottleModule } from './common/security/account-throttle.module';
import { winstonLoggerOptions } from './logger/winston.config';

import { PrismaModule } from './prisma/prisma.module';
import { TenantMiddleware } from './common/middleware/tenant.middleware';
import { JwtAuthGuard, RolesGuard } from './common/guards';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { TenantScopeInterceptor } from './common/interceptors/tenant-scope.interceptor';

import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { ProductsModule } from './modules/products/products.module';
import { CategoryTemplatesModule } from './modules/category-templates/category-templates.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PreviewModule } from './modules/preview/preview.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { DigitalModule } from './modules/digital/digital.module';
import { PlansModule } from './modules/plans/plans.module';
import { BillingModule } from './modules/billing/billing.module';
import { UsersModule } from './modules/users/users.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DevicesModule } from './modules/devices/devices.module';
import { VisitsModule } from './modules/visits/visits.module';
import { EmailTemplatesModule } from './modules/email-templates/email-templates.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { LocationsShippingModule } from './modules/locations-shipping/locations-shipping.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { PlatformModule } from './modules/platform/platform.module';
import { BackupsModule } from './modules/backups/backups.module';
import { QueueModule } from './queue/queue.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
      load: [
        appConfig,
        jwtConfig,
        jwtCustomerConfig,
        mobileAuthConfig,
        redisConfig,
        stripeConfig,
        mercadoPagoConfig,
        paypalConfig,
        digitalConfig,
        mailConfig,
        totpConfig,
        securityConfig,
        backupConfig,
        platformConfig,
      ],
    }),
    ScheduleModule.forRoot(),
    WinstonModule.forRoot(winstonLoggerOptions),
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: {
          host: process.env.REDIS_HOST ?? 'localhost',
          port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
        },
        // Without these, every finished job (email payloads carry reset links and
        // temporary passwords) stays in Redis forever and memory grows unbounded.
        defaultJobOptions: {
          removeOnComplete: { age: 60 * 60, count: 1000 },
          removeOnFail: { age: 24 * 60 * 60, count: 1000 },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [
          {
            ttl: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
            limit: parseInt(process.env.THROTTLE_LIMIT ?? '120', 10),
          },
        ],
        storage: new ThrottlerStorageRedisService(
          new Redis({
            host: process.env.REDIS_HOST ?? 'localhost',
            port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined,
          }),
        ),
      }),
    }),
    AccountThrottleModule,
    PrismaModule,
    QueueModule,
    AuthModule,
    TenantsModule,
    ProductsModule,
    CategoryTemplatesModule,
    OrdersModule,
    PreviewModule,
    PaymentsModule,
    DigitalModule,
    PlansModule,
    BillingModule,
    UsersModule,
    CustomersModule,
    DevicesModule,
    VisitsModule,
    EmailTemplatesModule,
    UploadsModule,
    CouponsModule,
    LocationsShippingModule,
    DashboardModule,
    PlatformModule,
    BackupsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantScopeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
