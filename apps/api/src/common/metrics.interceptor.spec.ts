import { HttpException, HttpStatus } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MetricsInterceptor } from './metrics.interceptor';

function createContext(request: Record<string, unknown>, response: Record<string, unknown> = {}) {
    return {
        getType: () => 'http',
        switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => ({ statusCode: 200, ...response }),
        }),
    } as any;
}

describe('MetricsInterceptor', () => {
    it('records successful HTTP requests with bounded route labels', async () => {
        const metricsService = { recordHttpRequest: vi.fn() };
        const interceptor = new MetricsInterceptor(metricsService as any);

        await lastValueFrom(interceptor.intercept(
            createContext({
                method: 'post',
                baseUrl: '/api/v1/schedules',
                route: { path: '/:id/publish' },
                path: '/api/v1/schedules/sch-123/publish',
            }),
            { handle: () => of({ ok: true }) } as any,
        ));

        expect(metricsService.recordHttpRequest).toHaveBeenCalledWith(
            'POST',
            '/api/v1/schedules/:id/publish',
            200,
            expect.any(Number),
        );
    });

    it('records thrown HTTP exceptions with the exception status', async () => {
        const metricsService = { recordHttpRequest: vi.fn() };
        const interceptor = new MetricsInterceptor(metricsService as any);
        const error = new HttpException('unavailable', HttpStatus.SERVICE_UNAVAILABLE);

        await expect(lastValueFrom(interceptor.intercept(
            createContext({
                method: 'GET',
                path: '/api/v1/tenants/018f4a41e4a7423db021f57d7db21b24',
            }),
            { handle: () => throwError(() => error) } as any,
        ))).rejects.toBe(error);

        expect(metricsService.recordHttpRequest).toHaveBeenCalledWith(
            'GET',
            '/api/v1/tenants/:id',
            503,
            expect.any(Number),
        );
    });
});
