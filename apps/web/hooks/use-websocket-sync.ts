'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

type SyncEvent = {
    type: string;
    payload: any;
    timestamp: string;
};

export function useWebSocketSync(tenantId: string) {
    const [socket, setSocket] = useState<WebSocket | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [lastSyncEvent, setLastSyncEvent] = useState<SyncEvent | null>(null);
    const reconnectTimeout = useRef<NodeJS.Timeout>();
    const retryCount = useRef(0);

    const connect = useCallback(() => {
        if (!tenantId) return;

        const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001';
        const ws = new WebSocket(`${wsUrl}/sync?tenantId=${tenantId}`);

        ws.onopen = () => {
            setIsConnected(true);
            retryCount.current = 0; // reset
            console.log('[WebSocket] Connected to sync server');
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data) as SyncEvent;
                console.log('[WebSocket] Sync Update Received:', data);
                setLastSyncEvent(data);
            } catch (err) {
                console.error('[WebSocket] Failed to parse message payload', err);
            }
        };

        ws.onclose = () => {
            setIsConnected(false);
            console.log('[WebSocket] Disconnected from sync server');

            // Exponential backoff reconnect
            const timeout = Math.min(1000 * Math.pow(2, retryCount.current), 30000);
            console.log(`[WebSocket] Reconnecting in ${timeout}ms...`);

            reconnectTimeout.current = setTimeout(() => {
                retryCount.current += 1;
                connect();
            }, timeout);
        };

        ws.onerror = (err) => {
            console.error('[WebSocket] Error occurred', err);
            ws.close();
        };

        setSocket(ws);
    }, [tenantId]);

    useEffect(() => {
        connect();

        return () => {
            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.close();
            }
        };
    }, [connect]);

    const sendMessage = useCallback((type: string, payload: any) => {
        if (socket && isConnected) {
            socket.send(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
        } else {
            console.warn('[WebSocket] Cannot send message, socket is disconnected');
        }
    }, [socket, isConnected]);

    return { isConnected, lastSyncEvent, sendMessage };
}
