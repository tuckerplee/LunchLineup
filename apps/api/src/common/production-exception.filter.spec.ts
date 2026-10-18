import { ArgumentsHost, BadRequestException, ConflictException, ForbiddenException, HttpException, InternalServerErrorException, Logger, NotFoundException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductionExceptionFilter } from './production-exception.filter';

describe('ProductionExceptionFilter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not leak unhandled exception messages', () => {
        const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const response = mockResponse();
        const host = mockHost(response);
        const filter = new ProductionExceptionFilter();

        filter.catch(new Error('DATABASE_URL=postgresql://user:super-secret@postgres:5432/app?api_key=abc123'), host);

        expect(response.status).toHaveBeenCalledWith(500);
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 500,
            message: 'Internal server error',
            correlationId: 'corr-1',
        }));
        const responseBody = JSON.stringify(response.json.mock.calls[0][0]);
        const logBody = JSON.stringify(logger.mock.calls);
        expect(responseBody).not.toContain('super-secret');
        expect(logBody).not.toContain('super-secret');
        expect(logBody).not.toContain('abc123');
        expect(logBody).toContain('category=unknown class=Error');
    });

    it('sanitizes HttpException messages in production responses', () => {
        const response = mockResponse();
        const host = mockHost(response);
        const filter = new ProductionExceptionFilter();

        filter.catch(new ForbiddenException('tenant secret detail'), host);

        expect(response.status).toHaveBeenCalledWith(403);
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Forbidden',
        }));
        expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain('tenant secret detail');
    });

    it.each([
        [
            new ForbiddenException({ code: 'SETUP_SHIFTS_ENTITLEMENT_REQUIRED', message: 'private billing detail' }),
            403,
            'SETUP_SHIFTS_ENTITLEMENT_REQUIRED',
            /paid subscription/i,
        ],
        [
            new ConflictException({ code: 'SETUP_SHIFTS_CONFLICT', message: 'private constraint detail' }),
            409,
            'SETUP_SHIFTS_CONFLICT',
            /refresh the selected date/i,
        ],
        [
            new ForbiddenException({ code: 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED', message: 'private wallet detail' }),
            403,
            'SHIFT_BREAKS_ENTITLEMENT_REQUIRED',
            /paid subscription/i,
        ],
        [
            new ConflictException({ code: 'SHIFT_BREAKS_CONFLICT', message: 'private shift detail' }),
            409,
            'SHIFT_BREAKS_CONFLICT',
            /review the shift and breaks/i,
        ],
    ])('emits an allowlisted public code and remediation without exception details', (exception, status, code, remediation) => {
        const response = mockResponse();
        const filter = new ProductionExceptionFilter();

        filter.catch(exception, mockHost(response, '/v1/lunch-breaks/setup-shifts'));

        expect(response.status).toHaveBeenCalledWith(status);
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: status,
            code,
            remediation: expect.stringMatching(remediation),
        }));
        expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain('private');
    });

    it('does not reflect unknown public error codes', () => {
        const response = mockResponse();
        const filter = new ProductionExceptionFilter();

        filter.catch(new ConflictException({ code: 'DATABASE_CONSTRAINT_NAME', message: 'private detail' }), mockHost(response));

        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 409,
            message: 'Conflict',
        }));
        expect(response.json.mock.calls[0][0]).not.toHaveProperty('code');
        expect(response.json.mock.calls[0][0]).not.toHaveProperty('remediation');
    });

    it('redacts OAuth callback query secrets from logs and response path', () => {
        const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const response = mockResponse();
        const host = mockHost(response, '/api/v1/auth/callback?code=super-secret-code&state=super-secret-state&next=/dashboard');
        const filter = new ProductionExceptionFilter();

        filter.catch(new Error('callback failed'), host);

        const responseBody = JSON.stringify(response.json.mock.calls[0][0]);
        const logBody = JSON.stringify(logger.mock.calls);
        expect(responseBody).not.toContain('super-secret-code');
        expect(responseBody).not.toContain('super-secret-state');
        expect(logBody).not.toContain('super-secret-code');
        expect(logBody).not.toContain('super-secret-state');
        expect(logBody).not.toContain('/api/v1/auth/callback');
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
            path: '/api/v1/auth/callback',
        }));
        expect(responseBody).not.toContain('next=/dashboard');
    });

    describe('client-visible rejection reasons', () => {
        const shiftMessage = 'Shift 6d7b0f4e-1111-4222-8333-944455556666 is assigned to staff with no applicable configured availability.';

        it.each([
            ['BadRequestException string', new BadRequestException(shiftMessage), 400],
            ['ConflictException string', new ConflictException(shiftMessage), 409],
            ['UnprocessableEntityException string', new UnprocessableEntityException(shiftMessage), 422],
            ['object form with message and unknown code', new BadRequestException({ message: shiftMessage, code: 'NOT_PUBLIC' }), 400],
        ])('passes the developer-authored message through for %s', (_name, exception, status) => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const response = mockResponse();
            new ProductionExceptionFilter().catch(exception, mockHost(response));

            expect(response.status).toHaveBeenCalledWith(status);
            const body = response.json.mock.calls[0][0];
            expect(body.message).toBe(shiftMessage);
            expect(body).not.toHaveProperty('code');
        });

        it.each([
            ['401', new UnauthorizedException('jwt expired for user@example.com'), 401, 'Authentication required'],
            ['403', new ForbiddenException('tenant secret detail'), 403, 'Forbidden'],
            ['404', new NotFoundException('Shift abc not found'), 404, 'Not found'],
            ['413', new HttpException('too big: 99MB', 413), 413, 'Payload too large'],
            ['429', new HttpException('throttled key=abc', 429), 429, 'Too many requests'],
            ['500 HttpException', new InternalServerErrorException('db password=hunter2'), 500, 'Internal server error'],
            ['503 HttpException', new HttpException('redis down at 10.0.0.5', 503), 503, 'Request failed'],
        ])('keeps the generic message for %s', (_name, exception, status, message) => {
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const response = mockResponse();
            new ProductionExceptionFilter().catch(exception, mockHost(response));

            expect(response.status).toHaveBeenCalledWith(status);
            expect(response.json.mock.calls[0][0].message).toBe(message);
        });

        it('never passes through non-HttpException messages even when they look like 4xx', () => {
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            const response = mockResponse();
            const prismaLike = Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), {
                code: 'P2002',
                status: 409,
                statusCode: 409,
            });
            new ProductionExceptionFilter().catch(prismaLike, mockHost(response));

            expect(response.status).toHaveBeenCalledWith(500);
            expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain('Unique constraint');
        });

        it('replaces class-validator arrays with a generic message and field names only', () => {
            const response = mockResponse();
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            new ProductionExceptionFilter().catch(new BadRequestException({
                statusCode: 400,
                error: 'Bad Request',
                message: [
                    'email must be an email',
                    'items.0.name should not be empty',
                    'each value in tags must be a string',
                    'email must be shorter than 255',
                ],
            }), mockHost(response));

            const body = response.json.mock.calls[0][0];
            expect(body.message).toBe('Request validation failed');
            expect(body.fields).toEqual(['email', 'items.0.name', 'tags']);
            expect(JSON.stringify(body)).not.toContain('must be an email');
            expect(String(warn.mock.calls[0][0])).toContain('fields=email,items.0.name,tags');
        });

        it('omits fields for validator arrays without parseable names', () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const response = mockResponse();
            new ProductionExceptionFilter().catch(new BadRequestException({ message: ['???'] }), mockHost(response));

            const body = response.json.mock.calls[0][0];
            expect(body.message).toBe('Request validation failed');
            expect(body).not.toHaveProperty('fields');
        });

        it('normalizes whitespace, control characters, secrets and length', () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const response = mockResponse();
            new ProductionExceptionFilter().catch(
                new BadRequestException(`  Invalid\n\t value\u0000\u0007   here  token=abc123 ${'y'.repeat(500)}`),
                mockHost(response),
            );

            const message: string = response.json.mock.calls[0][0].message;
            expect(message.startsWith('Invalid value here token=[REDACTED] y')).toBe(true);
            expect(message).not.toContain('abc123');
            expect(message).not.toMatch(/[\u0000-\u001f]/);
            expect(message.length).toBeLessThanOrEqual(300);
        });

        it('falls back to the generic message when the string is blank', () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const response = mockResponse();
            new ProductionExceptionFilter().catch(new BadRequestException('  \n '), mockHost(response));

            expect(response.json.mock.calls[0][0].message).toBe('Bad request');
        });

        it('allowlisted public codes still win over the pass-through message', () => {
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const response = mockResponse();
            new ProductionExceptionFilter().catch(
                new ConflictException({ code: 'SHIFT_BREAKS_CONFLICT', message: 'private shift detail' }),
                mockHost(response, '/v1/x'),
            );

            expect(response.json.mock.calls[0][0].message).toBe('Shift lunch/breaks conflict with current schedule data.');
        });
    });

    describe('request_rejected log line', () => {
        it('logs every 4xx at warn with method, redacted path, status, correlation id and reason', () => {
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            new ProductionExceptionFilter().catch(
                new BadRequestException('Shift s1 is outside configured staff availability.'),
                mockHost(mockResponse(), '/v1/schedules/s1/publish?token=super-secret'),
            );

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toBe(
                'request_rejected method=POST path=/v1/schedules/s1/publish status=400 correlationId=corr-1 reason="Shift s1 is outside configured staff availability."',
            );
            expect(String(warn.mock.calls[0][0])).not.toContain('super-secret');
        });

        it('logs the generic reason for suppressed 4xx statuses and does not leak the hidden message', () => {
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            new ProductionExceptionFilter().catch(new ForbiddenException('tenant secret detail'), mockHost(mockResponse()));

            expect(String(warn.mock.calls[0][0])).toContain('status=403');
            expect(String(warn.mock.calls[0][0])).toContain('reason="Forbidden"');
            expect(String(warn.mock.calls[0][0])).not.toContain('tenant secret detail');
        });

        it('does not warn for 5xx failures', () => {
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            new ProductionExceptionFilter().catch(new Error('boom'), mockHost(mockResponse()));

            expect(warn).not.toHaveBeenCalled();
        });
    });
});

function mockResponse() {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
    };
}

function mockHost(response: ReturnType<typeof mockResponse>, originalUrl = '/v1/private'): ArgumentsHost {
    return {
        switchToHttp: () => ({
            getRequest: () => ({
                method: 'POST',
                originalUrl,
                correlationId: 'corr-1',
            }),
            getResponse: () => response,
            getNext: () => undefined,
        }),
    } as unknown as ArgumentsHost;
}
