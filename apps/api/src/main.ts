import './common/telemetry';
import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import express from 'express';
import { AppModule } from './app.module';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import cookieParser from 'cookie-parser';
import {
    buildCorsOptions,
    captureRawBody,
    isProduction,
    resolveRequestBodyLimit,
    resolveTrustProxy,
    validateProductionEnvironment,
} from './common/bootstrap-security';
import { ProductionExceptionFilter } from './common/production-exception.filter';

async function bootstrap() {
    validateProductionEnvironment();

    const app = await NestFactory.create(AppModule, { bodyParser: false });
    const expressApp = app.getHttpAdapter().getInstance() as express.Express;
    const bodyLimit = resolveRequestBodyLimit();

    expressApp.disable('x-powered-by');
    expressApp.set('trust proxy', resolveTrustProxy());

    // 1. Double-Submit CSRF & Cookie Parsing
    app.use(cookieParser());
    app.use(express.json({ limit: bodyLimit, verify: captureRawBody }));
    app.use(express.urlencoded({ extended: true, limit: bodyLimit, verify: captureRawBody }));

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
    if (isProduction()) {
        app.useGlobalFilters(new ProductionExceptionFilter());
    }

    // 4. Security Headers (redundant but safe if Caddy is bypassed)
    app.enableCors(buildCorsOptions());

    await app.listen(Number(process.env.PORT ?? 3000), process.env.API_LISTEN_HOST ?? '0.0.0.0');
}
bootstrap();
