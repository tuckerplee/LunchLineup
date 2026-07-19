import { createApiV2Client } from '@lunchlineup/api-contract';
import { fetchApiV2WithSession } from './client-api';

export const apiV2 = createApiV2Client({
    baseUrl: '/api/v2',
    fetch: fetchApiV2WithSession,
});
