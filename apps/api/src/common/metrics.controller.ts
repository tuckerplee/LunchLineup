import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from '../common/metrics.service';

/**
 * Prometheus metrics endpoint — /metrics
 * Scraped by the Prometheus container defined in docker-compose.yml.
 * This endpoint should NOT be exposed externally (Caddy blocks it).
 */
@Controller('metrics')
export class MetricsController {
    constructor(private readonly metricsService: MetricsService) { }

    @Get()
    @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    async getMetrics(): Promise<string> {
        return this.metricsService.getMetrics();
    }
}
