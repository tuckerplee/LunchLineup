export const QA_ORIGIN = 'http://127.0.0.1:8080';

export function requireQaBaseUrl(value: string | undefined): string {
    if (value !== QA_ORIGIN) throw new Error(`Disposable QA requires BASE_URL=${QA_ORIGIN}.`);
    return QA_ORIGIN;
}

export function requireQaUrl(input: string, baseUrl = QA_ORIGIN): URL {
    requireQaBaseUrl(baseUrl);
    const url = new URL(input, baseUrl);
    if (url.origin !== QA_ORIGIN || url.protocol !== 'http:' || url.username || url.password) {
        // Retain no query strings or credentials in isolation evidence.
        throw new Error(`QA isolation denied ${url.protocol}//${url.host}${url.pathname}`);
    }
    return url;
}

export function requireQaResponse(url: string, status: number, location: string | undefined): void {
    const approved = requireQaUrl(url);
    if (status >= 300 && status < 400 && location) requireQaUrl(new URL(location, approved).toString());
}

export function requireQaContextOptions(options: { proxy?: unknown }): void {
    if (options.proxy !== undefined) throw new Error('QA isolation denied caller proxy overrides.');
}
