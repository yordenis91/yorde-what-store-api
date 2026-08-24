import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentTenantId, Public } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { VisitsService } from './visits.service';
import { CreateVisitDto } from './dto/create-visit.dto';

@ApiTags('storefront-visits')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront/visits')
export class VisitsController {
  constructor(private readonly visitsService: VisitsService) {}

  /** IP and user-agent come from the request itself, not the body — a beacon can't be trusted to self-report them. */
  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateVisitDto, @Req() req: Request) {
    return this.visitsService.create(tenantId, dto, req.ip, req.headers['user-agent']);
  }
}
