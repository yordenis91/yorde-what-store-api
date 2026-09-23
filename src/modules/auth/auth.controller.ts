import { BadRequestException, Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Public, CurrentUser, AuthenticatedUser } from '../../common/decorators';
import { AuthService, TokenPair } from './auth.service';
import { RegisterDto, LoginDto, VerifyTwoFactorDto, EnableTwoFactorDto, SwitchTenantDto } from './dto';

const REFRESH_COOKIE = 'refresh_token';

/** Tighter than the global 120/min — these guard credential/OTP brute force, not general API abuse. */
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, ...rest } = await this.authService.register(dto);
    this.setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto);
    if ('requiresTwoFactor' in result) return result;

    const { refreshToken, ...rest } = result;
    this.setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('2fa/verify')
  async verifyTwoFactor(@Body() dto: VerifyTwoFactorDto, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, ...rest } = await this.authService.verifyTwoFactor(dto.challengeToken, dto.code);
    this.setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Public()
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException('Missing refresh token');

    const tokens: TokenPair = await this.authService.refresh(token);
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.id);
  }

  @Post('logout')
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    const result = await this.authService.logout(user.id, token);
    res.clearCookie(REFRESH_COOKIE);
    return result;
  }

  @Post('switch-tenant')
  async switchTenant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SwitchTenantDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refreshToken, ...rest } = await this.authService.switchTenant(user.id, dto.tenantId);
    this.setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Post('2fa/setup')
  async setupTwoFactor(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.setupTwoFactor(user.id);
  }

  @Post('2fa/enable')
  async enableTwoFactor(@CurrentUser() user: AuthenticatedUser, @Body() dto: EnableTwoFactorDto) {
    return this.authService.enableTwoFactor(user.id, dto);
  }

  @Post('2fa/disable')
  async disableTwoFactor(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.disableTwoFactor(user.id);
  }

  private setRefreshCookie(res: Response, token: string) {
    if (!token) throw new BadRequestException('Missing refresh token');
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      // Secure by default: an operator forgetting to set NODE_ENV=production
      // must not silently ship refresh tokens without the Secure flag.
      // Opting into the insecure (non-HTTPS) behavior takes an explicit
      // NODE_ENV=development instead.
      secure: this.config.get<string>('app.env') !== 'development',
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
}
