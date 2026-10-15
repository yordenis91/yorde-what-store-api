import { Global, Module } from '@nestjs/common';
import { AccountThrottleService } from './account-throttle.service';

@Global()
@Module({ providers: [AccountThrottleService], exports: [AccountThrottleService] })
export class AccountThrottleModule {}
