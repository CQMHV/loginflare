import { useEffect, useRef } from 'react';

export function useFieldErrorFocus(fields: Record<string, string>, attempt: number) {
    const ref = useRef<HTMLDivElement>(null);
    const lastAttempt = useRef(-1);
    useEffect(() => {
        // Corrections clear errors without moving focus away from the field being edited.
        if (lastAttempt.current === attempt) return;
        lastAttempt.current = attempt;
        const field = Array.from(ref.current?.querySelectorAll<HTMLElement>('[name]') ?? [])
            .find((element) => Object.hasOwn(fields, element.getAttribute('name') ?? ''));
        field?.focus({ preventScroll: true });
        field?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, [fields, attempt]);
    return ref;
}

export function sameSelection(left: string[], right: string[]) {
    return left.length === right.length && left.every((value) => right.includes(value));
}
