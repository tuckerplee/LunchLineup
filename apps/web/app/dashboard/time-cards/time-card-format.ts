export function formatTimeCardDuration(minutes: number): string {
    const safe = Math.max(0, Math.floor(minutes || 0));
    const hours = Math.floor(safe / 60);
    const mins = safe % 60;
    if (hours === 0) return `${mins}m`;
    return `${hours}h ${String(mins).padStart(2, '0')}m`;
}
