import { BadRequestException, Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { EmailTemplatesService } from './email-templates.service';
import { UpsertEmailTemplateDto } from './dto/upsert-email-template.dto';
import { EmailTemplateKey, TEMPLATE_KEYS } from './default-templates';

function assertKnownKey(key: string): asserts key is EmailTemplateKey {
  if (!TEMPLATE_KEYS.includes(key as EmailTemplateKey)) {
    throw new BadRequestException(`Unknown email template key: ${key}`);
  }
}

@ApiTags('email-templates')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER')
@Controller('email-templates')
export class EmailTemplatesController {
  constructor(private readonly service: EmailTemplatesService) {}

  @Get()
  list(@CurrentTenantId() tenantId: string) {
    return this.service.listResolved(tenantId);
  }

  @Put(':key')
  upsert(@CurrentTenantId() tenantId: string, @Param('key') key: string, @Body() dto: UpsertEmailTemplateDto) {
    assertKnownKey(key);
    return this.service.upsert(tenantId, key, dto);
  }

  @Delete(':key')
  revert(@CurrentTenantId() tenantId: string, @Param('key') key: string) {
    assertKnownKey(key);
    return this.service.revertToDefault(tenantId, key);
  }
}
