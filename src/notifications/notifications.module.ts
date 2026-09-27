import { Module } from '@nestjs/common';
import { NoOpPushService, PUSH_SERVICE } from './push.service';

@Module({
  providers: [{ provide: PUSH_SERVICE, useClass: NoOpPushService }],
  exports: [PUSH_SERVICE],
})
export class NotificationsModule {}
