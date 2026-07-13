'use client';

import { useEffect, useRef, useState } from 'react';

const TURNSTILE_SCRIPT_ID = 'cloudflare-turnstile-api';
const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TURNSTILE_LOAD_TIMEOUT_MS = 5000;

type TurnstileRenderOptions = {
    sitekey: string;
    callback: (token: string) => void;
    'expired-callback': () => void;
    'error-callback': () => void;
    theme: 'light';
    size: 'normal';
};

type TurnstileApi = {
    render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
    reset?: (widgetId?: string) => void;
    remove?: (widgetId?: string) => void;
};

declare global {
    interface Window {
        turnstile?: TurnstileApi;
    }
}

type TurnstileChallengeProps = {
    enabled: boolean;
    siteKey: string;
    resetSignal: number;
    onTokenChange: (token: string) => void;
    onUnavailableChange: (unavailable: boolean) => void;
};

export function TurnstileChallenge({
    enabled,
    siteKey,
    resetSignal,
    onTokenChange,
    onUnavailableChange,
}: TurnstileChallengeProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const widgetIdRef = useRef<string | null>(null);
    const lastResetSignalRef = useRef(resetSignal);
    const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
    const trimmedSiteKey = siteKey.trim();
    const shouldRender = enabled && Boolean(trimmedSiteKey);

    useEffect(() => {
        if (!shouldRender) {
            onTokenChange('');
            onUnavailableChange(false);
            return;
        }

        let cancelled = false;
        let loadTimer: number | undefined;
        let script: HTMLScriptElement | null = null;

        const markUnavailable = () => {
            if (cancelled) return;
            setStatus('unavailable');
            onTokenChange('');
            onUnavailableChange(true);
        };

        const renderChallenge = () => {
            if (cancelled || !containerRef.current || widgetIdRef.current) return;
            if (!window.turnstile) {
                markUnavailable();
                return;
            }

            try {
                widgetIdRef.current = window.turnstile.render(containerRef.current, {
                    sitekey: trimmedSiteKey,
                    theme: 'light',
                    size: 'normal',
                    callback: (token) => {
                        setStatus('ready');
                        onUnavailableChange(false);
                        onTokenChange(token);
                    },
                    'expired-callback': () => {
                        setStatus('loading');
                        onTokenChange('');
                    },
                    'error-callback': markUnavailable,
                });
            } catch {
                markUnavailable();
            }
        };

        setStatus('loading');
        onTokenChange('');
        onUnavailableChange(false);

        if (window.turnstile) {
            renderChallenge();
        } else {
            script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
            if (!script) {
                script = document.createElement('script');
                script.id = TURNSTILE_SCRIPT_ID;
                script.src = TURNSTILE_SCRIPT_SRC;
                script.async = true;
                script.defer = true;
                document.head.appendChild(script);
            }

            const handleLoad = () => {
                if (loadTimer) {
                    window.clearTimeout(loadTimer);
                    loadTimer = undefined;
                }
                if (script) script.dataset.loaded = 'true';
                renderChallenge();
            };
            const handleError = () => markUnavailable();

            if (script.dataset.loaded === 'true') {
                renderChallenge();
            } else {
                script.addEventListener('load', handleLoad, { once: true });
                script.addEventListener('error', handleError, { once: true });
                loadTimer = window.setTimeout(markUnavailable, TURNSTILE_LOAD_TIMEOUT_MS);
            }

            return () => {
                cancelled = true;
                if (loadTimer) window.clearTimeout(loadTimer);
                script?.removeEventListener('load', handleLoad);
                script?.removeEventListener('error', handleError);
                if (widgetIdRef.current && window.turnstile?.remove) {
                    window.turnstile.remove(widgetIdRef.current);
                }
                widgetIdRef.current = null;
            };
        }

        return () => {
            cancelled = true;
            if (loadTimer) window.clearTimeout(loadTimer);
            if (widgetIdRef.current && window.turnstile?.remove) {
                window.turnstile.remove(widgetIdRef.current);
            }
            widgetIdRef.current = null;
        };
    }, [onTokenChange, onUnavailableChange, shouldRender, trimmedSiteKey]);

    useEffect(() => {
        if (lastResetSignalRef.current === resetSignal) return;
        lastResetSignalRef.current = resetSignal;
        if (!shouldRender || status === 'unavailable' || !widgetIdRef.current) return;

        onTokenChange('');
        setStatus('loading');
        try {
            window.turnstile?.reset?.(widgetIdRef.current);
        } catch {
            setStatus('unavailable');
            onUnavailableChange(true);
        }
    }, [onTokenChange, onUnavailableChange, resetSignal, shouldRender, status]);

    if (!shouldRender) return null;

    return (
        <div className="onb-challenge" data-status={status}>
            <div className="onb-challenge__header">
                <span className="onb-challenge__title">Signup security check</span>
                <span className="onb-challenge__status">
                    {status === 'ready' ? 'Complete' : status === 'unavailable' ? 'Unavailable' : 'Loading'}
                </span>
            </div>
            <div ref={containerRef} className="onb-challenge__widget" />
            <p className="onb-challenge__hint">
                {status === 'ready'
                    ? 'Security check complete. Your verification request is ready.'
                    : status === 'unavailable'
                        ? 'Security check is unavailable. Refresh the page and try again.'
                        : 'Security check is loading before we send or verify your code.'}
            </p>
        </div>
    );
}
