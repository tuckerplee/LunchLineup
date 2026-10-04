import type { ReactElement } from 'react';

type Hook = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Node = ReactElement<Record<string, any>>;

/**
 * A deterministic hook ledger for invoking the actual JSX event handlers.
 * This is not a DOM, React scheduling, hydration or browser acceptance model.
 * Effects run explicitly; asynchronous callbacks are never globally queued.
 */
export function clientComponentHarness(page: () => unknown) {
    const hooks: Hook[] = [];
    let index = 0;
    const effects: Array<() => void> = [];
    const listeners = new Set<() => void>();
    const slot = () => hooks[index] ?? (hooks[index] = {});
    const api = {
        useState(initial: unknown) {
            const cell = slot(); index += 1;
            if (!Object.hasOwn(cell, 'value')) cell.value = typeof initial === 'function' ? initial() : initial;
            return [cell.value, (next: unknown) => {
                cell.value = typeof next === 'function' ? next(cell.value) : next;
                for (const listener of [...listeners]) listener();
            }];
        },
        useRef(initial: unknown) {
            const cell = slot(); index += 1;
            if (!Object.hasOwn(cell, 'value')) cell.value = { current: initial };
            return cell.value;
        },
        useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
            const cell = slot(); index += 1;
            if (!deps || !cell.deps || deps.length !== cell.deps.length || deps.some((value, i) => !Object.is(value, cell.deps![i]))) {
                cell.deps = deps;
                effects.push(() => { cell.cleanup?.(); const cleanup = effect(); cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined; });
            }
        },
        useCallback(callback: unknown, deps?: readonly unknown[]) {
            const cell = slot(); index += 1;
            if (!deps || !cell.deps || deps.length !== cell.deps.length || deps.some((value, i) => !Object.is(value, cell.deps![i]))) {
                cell.value = callback; cell.deps = deps;
            }
            return cell.value;
        },
        useMemo(calculate: () => unknown, deps?: readonly unknown[]) {
            const cell = slot(); index += 1;
            if (!deps || !cell.deps || deps.length !== cell.deps.length || deps.some((value, i) => !Object.is(value, cell.deps![i]))) {
                cell.value = calculate(); cell.deps = deps;
            }
            return cell.value;
        },
    };
    function render(): unknown {
        index = 0;
        let tree = page();
        // Client pages wrap their private content component in Suspense.
        while (isNode(tree) && typeof tree.type !== 'string') {
            if (typeof tree.type === 'function') tree = (tree.type as (props: unknown) => unknown)(tree.props);
            else tree = tree.props.children;
        }
        return tree;
    }
    return {
        hooks: api,
        render,
        flushEffects() { for (const effect of effects.splice(0)) effect(); },
        unmount() { for (const hook of hooks) hook.cleanup?.(); listeners.clear(); },
        until(predicate: (tree: unknown) => boolean): Promise<void> {
            if (predicate(render())) return Promise.resolve();
            return new Promise(resolve => {
                const changed = () => { if (predicate(render())) { listeners.delete(changed); resolve(); } };
                listeners.add(changed);
            });
        },
    };
}

function isNode(value: unknown): value is Node {
    return Boolean(value && typeof value === 'object' && 'props' in value && 'type' in value);
}

export function nodes(tree: unknown): Node[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!isNode(tree)) return [];
    return [tree, ...nodes(tree.props.children)];
}

export function text(tree: unknown): string {
    if (Array.isArray(tree)) return tree.map(text).join(' ');
    if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
    if (!isNode(tree)) return '';
    return [typeof tree.props.message === 'string' ? tree.props.message : '', text(tree.props.children)].join(' ');
}

export function button(tree: unknown, label: string): Node {
    const found = nodes(tree).find(node => node.type === 'button' && text(node.props.children).trim().replace(/\s+/g, ' ') === label);
    if (!found) throw new Error(`Missing actual button: ${label}`);
    return found;
}

export function input(tree: unknown, label: string): Node {
    const group = nodes(tree).find(node => node.type === 'label' && text(node.props.children).trim() === label);
    const found = group && nodes(group.props.children).find(node => node.type === 'input');
    if (!found) throw new Error(`Missing actual labeled input: ${label}`);
    return found;
}

export function form(tree: unknown): Node {
    const forms = nodes(tree).filter(node => node.type === 'form');
    if (forms.length !== 1) throw new Error(`Expected one actual form; received ${forms.length}.`);
    return forms[0];
}

export function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

export const submitEvent = () => ({ preventDefault() {} });
export const changeEvent = (value: string) => ({ target: { value } });
