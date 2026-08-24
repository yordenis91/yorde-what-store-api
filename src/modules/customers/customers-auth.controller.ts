import { BadRequestException, Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { CurrentTenantId, Public } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { CurrentCustomerId } from './decorators/current-customer-id.decorator';
import { CustomerAuthGuard } from './guards/customer-auth.guard';
import { CustomersAuthService, CustomerTokenPair } from './customers-auth.service';
import { ForgotPasswordCustomerDto, LoginCustomerDto, RegisterCustomerDto, ResetPasswordCustomerDto } from './dto';

const REFRESH_COOKIE = 'customer_refresh_token';

@ApiTags('storefront-customer-auth')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront/customers/auth')
export class CustomersAuthController {
  constructor(
    private readonly authService: CustomersAuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('register')
  async register(
    @CurrentTenantId() tenantId: string,
    @Body() dto: RegisterCustomerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refreshToken, ...rest } = await this.authService.register(tenantId, dto);
    this.setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Post('login')
  async login(
    @CurrentTenantId() tenantId: string,
    @Body() dto: LoginCustomerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refreshToken, ...rest } = await this.authService.login(tenantId, dto);
    this.setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new BadRequestException('Missing refresh token');

    const tokens: CustomerTokenPair = await this.authService.refresh(token);
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post('logout')
  @UseGuards(CustomerAuthGuard)
  async logout(
    @CurrentCustomerId() customerId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = req.cookies?.[REFRESH_COOKIE];
    const result = await this.authService.logout(customerId, token);
    res.clearCookie(REFRESH_COOKIE);
    return result;
  }

  @Post('forgot-password')
  forgotPassword(@CurrentTenantId() tenantId: string, @Body() dto: ForgotPasswordCustomerDto, @Req() req: Request) {
    const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
    return this.authService.forgotPassword(tenantId, dto, origin);
  }

  @Post('reset-password')
  resetPassword(@CurrentTenantId() tenantId: string, @Body() dto: ResetPasswordCustomerDto) {
    return this.authService.resetPassword(tenantId, dto);
  }

  private setRefreshCookie(res: Response, token: string) {
    if (!token) throw new BadRequestException('Missing refresh token');
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.get<string>('app.env') === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
}
