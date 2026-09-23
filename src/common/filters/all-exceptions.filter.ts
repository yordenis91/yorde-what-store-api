import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Response } from 'express';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { Prisma } from '@prisma/client';
import { captureException } from '../../sentry';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    const { status, message, code } = this.resolve(exception);

    // Only unexpected server-side failures — a validation 400 or a 404 is
    // normal traffic, not something anyone needs paged for.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      captureException(exception, { path: request?.url, method: request?.method, tenantId: request?.tenantId });
    }

    // A dependency being unreachable is not "a bug" — logging it under the
    // same event name as every application error is what made a Postgres
    // outage look, from the API's own logs, indistinguishable from a code
    // defect. This event name is deliberately different so it's greppable
    // on its own and doesn't get lost in the usual request_error noise.
    if (code === 'DATABASE_UNAVAILABLE') {
      this.logger.error('database_unavailable — requests will keep failing until the DB is reachable again', {
        path: request?.url,
        method: request?.method,
        tenantId: request?.tenantId,
        detail: exception instanceof Error ? exception.message : undefined,
      });
    } else {
      this.logger.error('request_error', {
        status,
        message,
        code,
        path: request?.url,
        method: request?.method,
        tenantId: request?.tenantId,
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      code,
      message,
      path: request?.url,
      timestamp: new Date().toISOString(),
    });
  }

  private resolve(exception: unknown): { status: number; message: string | string[]; code: string } {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : ((body as any).message ?? exception.message);
      return { status: exception.getStatus(), message, code: exception.constructor.name };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return { status: HttpStatus.CONFLICT, message: 'A record with this value already exists', code: 'P2002' };
      }
      if (exception.code === 'P2025') {
        return { status: HttpStatus.NOT_FOUND, message: 'Record not found', code: 'P2025' };
      }
      return { status: HttpStatus.BAD_REQUEST, message: 'Database request error', code: exception.code };
    }

    // Thrown when Prisma can't even reach Postgres (connection refused, out
    // of disk, the DB mid-crash-loop, ...) — a dependency outage, not a bug
    // in this request. 503 (not 500) says so to any caller/monitor that
    // cares to distinguish the two, and the distinct log event above makes
    // it immediately greppable instead of blending into generic 500 noise.
    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Database temporarily unavailable',
        code: 'DATABASE_UNAVAILABLE',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    };
  }
}
