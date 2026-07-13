import { ForbiddenException, VERSION_NEUTRAL } from "@nestjs/common";
import { VERSION_METADATA } from "@nestjs/common/constants";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsController } from "./metrics.controller";

describe("MetricsController", () => {
  let controller: MetricsController;
  let metricsService: { getMetrics: ReturnType<typeof vi.fn> };
  let configService: { get: ReturnType<typeof vi.fn> };
  let healthService: { check: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    metricsService = {
      getMetrics: vi.fn().mockResolvedValue("prometheus_metrics 1"),
    };
    configService = { get: vi.fn().mockReturnValue(undefined) };
    healthService = {
      check: vi.fn().mockResolvedValue({ status: "ok", checks: [] }),
    };

    controller = new MetricsController(
      metricsService as any,
      configService as any,
      healthService as any,
    );
  });

  it("stays version-neutral at the Prometheus scrape path", () => {
    expect(Reflect.getMetadata(VERSION_METADATA, MetricsController)).toBe(
      VERSION_NEUTRAL,
    );
  });

  it("allows a configured metrics token", async () => {
    configService.get.mockReturnValue("scrape-token");

    const result = await controller.getMetrics({
      headers: { "x-metrics-token": "scrape-token" },
    } as any);

    expect(result).toBe("prometheus_metrics 1");
    expect(healthService.check).toHaveBeenCalledOnce();
  });

  it("allows the compose metrics token file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lunchlineup-metrics-"));
    const tokenFile = join(dir, "metrics_token");
    writeFileSync(tokenFile, "file-token\n", "utf8");
    configService.get.mockImplementation((key: string) =>
      key === "METRICS_TOKEN_FILE" ? tokenFile : undefined,
    );

    try {
      const result = await controller.getMetrics({
        headers: { authorization: "Bearer file-token" },
      } as any);

      expect(result).toBe("prometheus_metrics 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects normal application bearer tokens that are not the metrics token", async () => {
    configService.get.mockReturnValue("scrape-token");

    await expect(
      controller.getMetrics({
        headers: { authorization: "Bearer user-access-token" },
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(metricsService.getMetrics).not.toHaveBeenCalled();
    expect(healthService.check).not.toHaveBeenCalled();
  });

  it("rejects missing tokens and permissions", async () => {
    await expect(
      controller.getMetrics({ headers: {} } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(metricsService.getMetrics).not.toHaveBeenCalled();
    expect(healthService.check).not.toHaveBeenCalled();
  });
});
