import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
    it('returns a fixed validation response without custom secret-bearing issue text', () => {
        const schema = z.string().superRefine((_value, context) => {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Authorization: Bearer access-secret owner@example.com',
            });
        });
        const pipe = new ZodValidationPipe();

        try {
            pipe.transform('provider-payload-secret', { schema } as never);
            throw new Error('Expected validation to fail');
        } catch (error) {
            expect(error).toBeInstanceOf(BadRequestException);
            const response = (error as BadRequestException).getResponse();
            expect(response).toEqual({
                message: 'Validation failed',
                errorCount: 1,
            });
            expect(JSON.stringify(response)).not.toContain('access-secret');
            expect(JSON.stringify(response)).not.toContain('owner@example.com');
            expect(JSON.stringify(response)).not.toContain('provider-payload-secret');
        }
    });
});
