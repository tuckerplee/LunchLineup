import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Req,
  SetMetadata,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import crypto from "crypto";
import { Request } from "express";
import { readFileSync } from "fs";
import { HealthService } from "./health.service";
import { MetricsService } from "../common/metrics.service";

const Public = () => SetMetadata("isPublic", true);

/**
 * Prometheus metrics endpoint - /metrics
 * Scraped by the Prometheus container defined in docker-compose.yml.
 * Requires the configured METRICS_TOKEN or METRICS_TOKEN_FILE bearer token.
 */
@Controller({ path: "metrics", version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly configService: ConfigService,
    private readonly healthService: HealthService,
  ) {}

  @Get()
  @Public()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async getMetrics(@Req() req: Request): Promise<string> {
    await this.assertMetricsAccess(req);
    await this.healthService.check();
    return this.metricsService.getMetrics();
  }

  private async assertMetricsAccess(req: Request): Promise<void> {
    if (this.hasValidMetricsToken(req)) {
      return;
    }

    throw new ForbiddenException(
      "Metrics access requires the configured metrics token.",
    );
  }

  private hasValidMetricsToken(req: Request): boolean {
    const configuredToken = this.configuredMetricsToken();
    if (!configuredToken) {
      return false;
    }

    const presentedToken =
      this.headerValue(req, "x-metrics-token") ?? this.extractBearerToken(req);
    if (!presentedToken) {
      return false;
    }

    return this.timingSafeEqual(presentedToken, configuredToken);
  }

  private configuredMetricsToken(): string | null {
    const directToken =
      this.configService.get<string>("METRICS_TOKEN") ??
      process.env.METRICS_TOKEN;
    if (directToken) {
      return directToken;
    }

    const tokenFile =
      this.configService.get<string>("METRICS_TOKEN_FILE") ??
      process.env.METRICS_TOKEN_FILE;
    if (!tokenFile) {
      return null;
    }

    try {
      return readFileSync(tokenFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  private extractBearerToken(req: Request): string | null {
    const authorization = this.headerValue(req, "authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return null;
    }

    return authorization.slice("Bearer ".length).trim() || null;
  }

  private headerValue(req: Request, header: string): string | null {
    const value = req.headers[header.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }
    return value ?? null;
  }

  private timingSafeEqual(candidate: string, expected: string): boolean {
    const candidateBuffer = Buffer.from(candidate);
    const expectedBuffer = Buffer.from(expected);
    if (candidateBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
  }
}
