import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { BullModule } from '@nestjs/bullmq';
import { EMAIL_QUEUE } from '../../queue/queue.constants';
import { AuthModule } from '../auth/auth.module';
import { CustomersAuthController } from './customers-auth.controller';
import { CustomersController } from './customers.controller';
import { CustomersAuthService } from './customers-auth.service';
import { CustomersService } from './customers.service';
import { CustomerJwtStrategy } from './strategies/customer-jwt.strategy';

@Module({
  // AuthModule exports JwtModule so this reuses the app's one JwtService
  // instance rather than registering a second (see auth.module.ts's comment).
  imports: [PassportModule, AuthModule, BullModule.registerQueue({ name: EMAIL_QUEUE })],
  controllers: [CustomersAuthController, CustomersController],
  providers: [CustomersAuthService, CustomersService, CustomerJwtStrategy],
})
export class CustomersModule {}
