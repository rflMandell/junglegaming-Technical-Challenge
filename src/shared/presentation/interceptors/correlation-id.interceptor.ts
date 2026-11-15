import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { v7 as uuidv7 } from 'uuid';
import type { Request, Response } from 'express';

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { correlationId?: string }>();
    const res = http.getResponse<Response>();

    const correlationId =
      (req.headers['x-correlation-id'] as string) || uuidv7();

    req.correlationId = correlationId;
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('X-Correlation-Id', correlationId);
    }

    return next.handle();
  }
}
