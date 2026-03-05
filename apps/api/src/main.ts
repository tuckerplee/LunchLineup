import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { ConfigLoader, SystemEnvironment } from '@lunchlineup/config';
import cookieParser from 'cookie-parser';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    // 1. Double-Submit CSRF & Cookie Parsing
    app.use(cookieParser());

    // Register Security Headers Middleware
    const { SecurityHeadersMiddleware } = await import('./middleware/security-headers.middleware');
    app.use(new SecurityHeadersMiddleware().use);

    // Register Host Validation Middleware
    const { HostValidationMiddleware } = await import('./middleware/host-validation.middleware');
    app.use(new HostValidationMiddleware().use);

    // 2. API Versioning (Architecture Part IV)
    app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: '1',
    });

    // 3. Global Zod Validation Pipe
    app.useGlobalPipes(new ZodValidationPipe());

    // 4. Security Headers (redundant but safe if Caddy is bypassed)
    app.enableCors({
        origin: process.env.ALLOWED_ORIGINS?.split(',') || 'https://localhost:3000',
        credentials: true,
    });

    await app.listen(3000, '0.0.0.0');
}
bootstrap();
