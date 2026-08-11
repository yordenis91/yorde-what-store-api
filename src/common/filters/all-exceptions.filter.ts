import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Response } from 'express';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { Prisma } from '@prisma/client';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    const { status, message, code } = this.resolve(exception);

    this.logger.error('request_error', {
      status,
      message,
      code,
      path: request?.url,
      method: request?.method,
      tenantId: request?.tenantId,
      stack: exception instanceof Error ? exception.stack : undefined,
    });

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
      const message = typeof body === 'string' ? body : (body as any).message ?? exception.message;
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

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    };
  }
}
