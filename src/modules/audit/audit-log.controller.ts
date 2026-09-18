import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { AuditLogService } from './audit-log.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';

@ApiTags('platform-audit')
@Roles('SUPER_ADMIN')
@Controller('platform/audit-logs')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @ApiOperation({ summary: 'Platform-wide audit trail: who did what, when, from where — paginated and filterable' })
  @Get()
  list(@Query() query: AuditLogQueryDto) {
    return this.auditLog.list(query);
  }

  @ApiOperation({ summary: 'Distinct action names logged so far, for populating a filter dropdown' })
  @Get('actions')
  listActions() {
    return this.auditLog.listDistinctActions();
  }
}
