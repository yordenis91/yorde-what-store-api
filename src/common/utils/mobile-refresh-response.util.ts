import { Request, Response } from 'express';

export interface MobileRefreshOk {
  ok: true;
  accessToken: string;
  refreshToken: string;
}
export interface MobileRefreshFailed {
  ok: false;
}
export type MobileRefreshResult = MobileRefreshOk | MobileRefreshFailed;

/**
 * Writes the HTTP response for a mobile-refresh endpoint by hand via `@Res()`
 * (no `passthrough`), instead of the usual "return a value / throw" flow
 * every other route uses.
 *
 * Why: `TenantScopeInterceptor` wraps a tenant-scoped request (any request
 * that resolved an `X-Tenant-ID`) in one Postgres transaction for its whole
 * lifetime, and Prisma rolls that transaction back if the request ultimately
 * throws. `AuthService.mobileRefresh`'s reuse-detection branch *writes* a
 * revocation and then needs to reject the request — if that rejection were a
 * thrown exception, the transaction would roll back and silently undo the
 * very revocation the write was for. This isn't a customer-only concern:
 * the staff mobile client attaches `X-Tenant-ID` on every request once a
 * tenant is active, including its own /auth/mobile/refresh calls, so the
 * staff endpoint is tenant-scoped (and hits the same transaction) in normal
 * use even though it doesn't need tenant data itself.
 *
 * Returning a value and letting the interceptor pipeline finish normally
 * (rather than throwing) keeps the request on Nest's "success" path, so the
 * transaction commits — while this still sends 401 to the caller by hand.
 * The two envelopes below are copied from TransformInterceptor (success) and
 * AllExceptionsFilter (failure) — keep them in sync if either changes shape.
 */
export function respondMobileRefresh(res: Response, req: Request, result: MobileRefreshResult): void {
  if (result.ok) {
    res.status(201).json({
      success: true,
      data: { accessToken: result.accessToken, refreshToken: result.refreshToken },
    });
    return;
  }
  res.status(401).json({
    success: false,
    statusCode: 401,
    code: 'UnauthorizedException',
    message: 'Refresh token no longer valid',
    path: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
}
