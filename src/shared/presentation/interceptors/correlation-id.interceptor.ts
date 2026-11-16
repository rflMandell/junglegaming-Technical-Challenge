import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Optional,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { v7 as uuidv7 } from 'uuid';
import type { Request, Response } from 'express';
import { MetricsService } from '../../../modules/metrics/metrics.service';

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  constructor(
    @Optional()
    private readonly metricsService?: MetricsService,
  ) {}

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

    const start = performance.now();
    return next.handle().pipe(
      tap(() => {
        const duration = performance.now() - start;
        this.metricsService?.recordProcessingDuration('http_request', duration);
      }),
    );
  }
}

