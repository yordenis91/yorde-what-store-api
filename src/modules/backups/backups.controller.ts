import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Roles } from '../../common/decorators';
import { BackupsService } from './backups.service';

class RestoreBackupDto {
  @IsString()
  key: string;

  /** A scratch database, never the one currently serving traffic — BackupsService.restore() refuses a match against DATABASE_URL. */
  @Matches(/^postgre?sql:\/\/.+@.+:\d+\/.+$/, {
    message: 'targetDatabaseUrl must be a valid PostgreSQL connection URL (postgresql://user:pass@host:port/database)',
  })
  targetDatabaseUrl: string;
}

@ApiTags('platform')
@Roles('SUPER_ADMIN')
@Controller('platform/backups')
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  list() {
    return this.backups.list();
  }

  @Post('run')
  run() {
    return this.backups.run();
  }

  /**
   * The restore drill: proves a specific backup is actually usable, not just
   * that it uploaded. `targetDatabaseUrl` must point at a scratch database —
   * the service rejects anything matching the live DATABASE_URL.
   */
  @Post('restore')
  async restore(@Body() dto: RestoreBackupDto) {
    await this.backups.restore(dto.key, dto.targetDatabaseUrl);
    return { restored: dto.key };
  }
}
