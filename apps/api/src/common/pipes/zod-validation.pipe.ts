import { PipeTransform, Injectable, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
    transform(value: any, metadata: ArgumentMetadata) {
        const schema = (metadata as any).schema as ZodSchema | undefined;

        if (!schema) {
            return value;
        }

        const result = schema.safeParse(value);
        if (!result.success) {
            throw new BadRequestException({
                message: 'Validation failed',
                errors: result.error.errors.map(err => ({
                    path: err.path.join('.'),
                    message: err.message
                }))
            });
        }

        return result.data;
    }
}
