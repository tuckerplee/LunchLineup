/** A mode flag can close effects; it cannot grant operation authority. */
const startupMode = process.env.TENANT_EXPORT_PILOT_MODE;
export function pilotProducersClosed(): boolean {
    const mode = startupMode;
    if (mode !== undefined && mode !== 'true' && mode !== 'false') {
        throw new Error('TENANT_EXPORT_PILOT_MODE must be canonical true or false.');
    }
    return mode === 'true';
}

export function requireOrdinaryProducer(effect: string): void {
    if (pilotProducersClosed()) throw new Error(`Pilot producer is closed: ${effect}`);
}
