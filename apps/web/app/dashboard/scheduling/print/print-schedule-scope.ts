export type PrintScheduleScope = Readonly<{
    date: string;
    requestedLocationId: string;
}>;

export function createPrintScheduleScope(date: string, requestedLocationId?: string | null): PrintScheduleScope {
    return {
        date,
        requestedLocationId: requestedLocationId ?? '',
    };
}

export function isPrintScheduleScopeCurrent(
    loadedScope: PrintScheduleScope | null,
    selectedScope: PrintScheduleScope,
): boolean {
    return Boolean(
        loadedScope
        && loadedScope.date === selectedScope.date
        && loadedScope.requestedLocationId === selectedScope.requestedLocationId,
    );
}
