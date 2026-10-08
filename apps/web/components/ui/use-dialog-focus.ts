'use client';

import { useCallback, useEffect, useRef } from 'react';

const controlSelector = 'button, a[href], input, select, textarea, [tabindex]';

function available(element: HTMLElement): boolean {
    return element.isConnected
        && !element.matches(':disabled')
        && !element.closest('[hidden], [inert], [aria-hidden="true"]')
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility === 'visible';
}

function controls(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(controlSelector))
        .filter(element => element.tabIndex >= 0 && available(element));
}

/** Focus behavior for one conditionally mounted dialog, including a portaled dialog.
 * Capture the opener in its event handler, before rendering any autoFocus child.
 * The dialog element must have tabIndex={-1}; dismissal remains the caller's job.
 */
export function useDialogFocus(open: boolean) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const returnFocus = useRef<{ trigger: HTMLElement; fallback: HTMLElement | null; dialog: HTMLElement | null } | null>(null);
    const captureTrigger = useCallback((trigger: HTMLElement, fallback: HTMLElement | null = null) => {
        returnFocus.current = { trigger, fallback, dialog: null };
    }, []);

    useEffect(() => {
        const owner = returnFocus.current;
        const restoreFocus = () => {
            if (!owner || returnFocus.current !== owner) return;
            returnFocus.current = null;
            const focused = document.activeElement;
            const nextDialog = focused instanceof HTMLElement
                ? focused.closest<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')
                : null;
            // A successful action can replace this confirmation with another
            // dialog in the same commit. Keep its deliberate autofocus instead
            // of pulling focus back to a now-disabled opener or the page.
            if (nextDialog && nextDialog !== owner.dialog && available(nextDialog)
                && focused instanceof HTMLElement && available(focused)) return;
            if (available(owner.trigger)) {
                owner.trigger.focus();
                return;
            }
            // The caller chooses a safe, same-surface fallback when a mutation
            // can disable/remove the opener. Never choose an arbitrary action.
            if (owner.fallback && available(owner.fallback)) owner.fallback.focus();
        };
        if (!open) {
            restoreFocus();
            return;
        }
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (owner) owner.dialog = dialog;
        const focusFirst = () => (controls(dialog)[0] ?? dialog).focus();
        if (!dialog.contains(document.activeElement)) focusFirst();

        const containFocus = (event: FocusEvent) => {
            if (dialog.isConnected && !dialog.contains(event.target as Node)) focusFirst();
        };
        const containTab = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || !dialog.isConnected) return;
            const items = controls(dialog);
            const index = items.indexOf(document.activeElement as HTMLElement);
            if (items.length === 0) {
                event.preventDefault();
                dialog.focus();
            } else if (event.shiftKey ? index <= 0 : index === -1 || index === items.length - 1) {
                event.preventDefault();
                items[event.shiftKey ? items.length - 1 : 0].focus();
            }
        };
        document.addEventListener('focusin', containFocus, true);
        document.addEventListener('keydown', containTab, true);
        return () => {
            document.removeEventListener('focusin', containFocus, true);
            document.removeEventListener('keydown', containTab, true);
            // StrictMode replays effect setup/cleanup while the dialog remains
            // mounted. Only an actual removal may restore focus from cleanup.
            queueMicrotask(() => {
                if (!dialog.isConnected) restoreFocus();
            });
        };
    }, [open]);

    return { dialogRef, captureTrigger };
}
