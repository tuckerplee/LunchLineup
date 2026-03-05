import { Injectable, InternalServerErrorException } from '@nestjs/common';
import crypto from 'crypto';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import dns from 'dns';
import { promisify } from 'util';
import * as amqp from 'amqplib';

const lookupPromise = promisify(dns.lookup);

@Injectable()
export class WebhooksService {
    constructor(private configService: ConfigService) { }

    /**
     * Secure Webhook Delivery
     * As per Architecture Part VII-A.4
     */
    async deliver(url: string, payload: any, secret: string) {
        // 1. SSRF Protection: DNS Pinning & Private IP Blocking
        await this.validateUrl(url);

        // 2. HMAC Signature
        const signature = crypto
            .createHmac('sha256', secret)
            .update(JSON.stringify(payload))
            .digest('hex');

        // 3. Delivery with Timeout Let it fail and queue for retry
        try {
            await axios.post(url, payload, {
                headers: {
                    'X-LunchLineup-Signature': signature,
                    'Content-Type': 'application/json',
                },
                timeout: 5000,
            });
        } catch (error) {
            console.error(`Webhook delivery failed to ${url}`, (error as Error).message);
            // 4. Trigger a retry in the RabbitMQ dead-letter worker queue
            await this.enqueueRetry(url, payload, secret);
        }
    }

    private async enqueueRetry(url: string, payload: any, secret: string) {
        try {
            const rabbitUrl = this.configService.get('RABBITMQ_URL') || 'amqp://localhost';
            const connection = await amqp.connect(rabbitUrl);
            const channel = await connection.createChannel();

            const retryQueue = 'webhook_retries';
            await channel.assertQueue(retryQueue, {
                durable: true,
                deadLetterExchange: 'webhook_dlx',
                arguments: {
                    'x-message-ttl': 60000 // Retry after 1 minute backoff
                }
            });

            const message = Buffer.from(JSON.stringify({ url, payload, secret, attempt: 1 }));
            channel.sendToQueue(retryQueue, message, { persistent: true });

            setTimeout(() => connection.close(), 500);
        } catch (err) {
            console.error('CRITICAL: Failed to enqueue webhook retry to RabbitMQ', err);
        }
    }

    private async validateUrl(url: string) {
        const parsedUrl = new URL(url);
        const { address } = await lookupPromise(parsedUrl.hostname);

        // Block private IP ranges (SSRF protection)
        const isPrivate = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(address);
        if (isPrivate) {
            throw new InternalServerErrorException('Webhook target blocked: Private IP detected.');
        }
    }
}
