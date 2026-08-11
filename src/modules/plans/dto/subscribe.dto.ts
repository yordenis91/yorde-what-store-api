import { IsUUID } from 'class-validator';

export class SubscribeDto {
  @IsUUID()
  planId: string;
}
