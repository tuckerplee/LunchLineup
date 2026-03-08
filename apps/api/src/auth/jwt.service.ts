import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

export interface TokenPayload {
    sub: string;       // userId
    tenantId: string;
    role: string;
    sessionId: string;
    mfaVerified: boolean;
}

@Injectable()
export class JwtService {
    private static readonly ACCESS_TOKEN_TTL_MINUTES = 30;
    private static readonly REFRESH_TOKEN_TTL_DAYS = 7;

    private readonly accessSecret: string;
    private readonly refreshSecret: string;
    private readonly accessTtl: number;  // minutes
    private readonly refreshTtl: number; // days

    constructor(private configService: ConfigService) {
        this.accessSecret = this.configService.getOrThrow<string>('JWT_SECRET');
        this.refreshSecret = this.configService.getOrThrow<string>('JWT_REFRESH_SECRET');
        this.accessTtl = JwtService.ACCESS_TOKEN_TTL_MINUTES;
        this.refreshTtl = JwtService.REFRESH_TOKEN_TTL_DAYS;
    }

    generateAccessToken(payload: TokenPayload): string {
        return jwt.sign(payload, this.accessSecret, {
            expiresIn: `${this.accessTtl}m`,
            issuer: 'lunchlineup',
            audience: 'lunchlineup-api',
        });
    }

    generateRefreshToken(payload: Pick<TokenPayload, 'sub' | 'sessionId'>): string {
        return jwt.sign(payload, this.refreshSecret, {
            expiresIn: `${this.refreshTtl}d`,
            issuer: 'lunchlineup',
        });
    }

    verifyAccessToken(token: string): TokenPayload {
        return jwt.verify(token, this.accessSecret, {
            issuer: 'lunchlineup',
            audience: 'lunchlineup-api',
        }) as TokenPayload;
    }

    verifyRefreshToken(token: string): Pick<TokenPayload, 'sub' | 'sessionId'> {
        return jwt.verify(token, this.refreshSecret, {
            issuer: 'lunchlineup',
        }) as Pick<TokenPayload, 'sub' | 'sessionId'>;
    }

    generateCsrfToken(): string {
        return crypto.randomBytes(32).toString('hex');
    }
}
