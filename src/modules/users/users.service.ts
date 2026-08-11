import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_QUEUE } from '../../queue/queue.constants';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InviteStaffDto, UpdateMemberDto } from './dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue,
  ) {}

  async listMembers(tenantId: string) {
    return this.prisma.tenantMember.findMany({
      where: { tenantId },
      include: { user: { select: { id: true, email: true, name: true, isActive: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async inviteStaff(tenantId: string, dto: InviteStaffDto) {
    let user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    if (!user) {
      const passwordHash = await bcrypt.hash(dto.temporaryPassword, BCRYPT_ROUNDS);
      user = await this.prisma.user.create({ data: { email: dto.email, name: dto.name, passwordHash } });
    }

    const existingMembership = await this.prisma.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId: user.id } },
    });
    if (existingMembership) throw new ConflictException('User is already a member of this store');

    const membership = await this.prisma.tenantMember.create({
      data: { tenantId, userId: user.id, role: 'STAFF', permissions: dto.permissions ?? [] },
    });

    await this.emailQueue.add('staff-invite', {
      email: dto.email,
      name: dto.name,
      temporaryPassword: dto.temporaryPassword,
    });

    return membership;
  }

  async updateMember(tenantId: string, memberId: string, dto: UpdateMemberDto) {
    const member = await this.prisma.tenantMember.findFirst({ where: { id: memberId, tenantId } });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role === 'OWNER') throw new ConflictException('Cannot modify the store owner membership');

    return this.prisma.tenantMember.update({ where: { id: memberId }, data: dto as any });
  }

  async removeMember(tenantId: string, memberId: string) {
    const member = await this.prisma.tenantMember.findFirst({ where: { id: memberId, tenantId } });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role === 'OWNER') throw new ConflictException('Cannot remove the store owner');

    await this.prisma.tenantMember.update({ where: { id: memberId }, data: { isActive: false } });
    return { removed: true };
  }
}
