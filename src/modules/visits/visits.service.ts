import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { anonymizeIp } from '../../common/utils/anonymize-ip.util';
import { CreateVisitDto } from './dto/create-visit.dto';

@Injectable()
export class VisitsService {
  constructor(private readonly prisma: PrismaService) {}

  create(tenantId: string, dto: CreateVisitDto, ip: string | undefined, userAgent: string | undefined) {
    return this.prisma.db.visit.create({
      data: {
        tenantId,
        path: dto.path,
        referrer: dto.referrer,
        sessionId: dto.sessionId,
        ip: anonymizeIp(ip),
        userAgent: userAgent?.slice(0, 300),
      },
    });
  }
}
