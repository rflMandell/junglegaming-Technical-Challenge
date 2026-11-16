import { Controller, Get, Query, Headers, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

@ApiTags('Metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @ApiOperation({
    summary: 'Export Prometheus metrics or JSON metrics summary',
    description: 'Returns Prometheus text format (default) or JSON when requested via ?format=json',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['prometheus', 'json'], description: 'Format of metrics output' })
  @ApiResponse({ status: 200, description: 'Metrics payload returned successfully' })
  getMetrics(
    @Query('format') format: string | undefined,
    @Headers('accept') acceptHeader: string | undefined,
    @Res() res: Response,
  ): void {
    const isJson = format === 'json' || (acceptHeader && acceptHeader.includes('application/json'));

    if (isJson) {
      res.setHeader('Content-Type', 'application/json');
      res.status(200).json(this.metricsService.getJsonMetrics());
      return;
    }

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(this.metricsService.getPrometheusMetrics());
  }
}
