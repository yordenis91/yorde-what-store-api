import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';

export interface ApiResponse<T> {
  success: true;
  data: T;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  // `@Sse()` handlers already emit each value as { data, type?, id? } — the
  // shape Nest's own SSE writer expects. Wrapping that in { success, data }
  // too would double-nest it and break the stream.
  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T> | T> {
    const isSse = this.reflector.get<boolean>(SSE_METADATA, context.getHandler());
    if (isSse) return next.handle();
    return next.handle().pipe(map((data) => ({ success: true, data })));
  }
}
