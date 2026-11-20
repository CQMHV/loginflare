import { useId, useLayoutEffect, useRef, type PropsWithChildren, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Dialog({ title, className, children, actions, tools, onCancel, onOpen, busy = false }: PropsWithChildren<{
    title: string; className: string; actions: ReactNode; tools?: ReactNode; onCancel: () => void; onOpen?: () => void; busy?: boolean;
}>) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const openCallback = useRef(onOpen);
    openCallback.current = onOpen;

    useLayoutEffect(() => {
        const dialog = dialogRef.current!;
        const previous = document.activeElement;
        let mounted = true;
        // Let the Material form controls render their shadow DOM before initial focus.
        queueMicrotask(() => {
            if (!mounted) return;
            dialog.show();
            openCallback.current?.();
        });
        return () => {
            mounted = false;
            if (!dialog.open) return;
            const restoreFocus = dialog.contains(document.activeElement);
            dialog.close();
            if (restoreFocus && previous instanceof HTMLElement && previous.isConnected && document.activeElement !== previous) {
                previous.focus({ preventScroll: true });
            }
        };
    }, []);

    return createPortal(<dialog ref={dialogRef} className={`app-dialog ${className}`} aria-labelledby={titleId} closedby="closerequest"
        onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onCancel();
        }}
        onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented || 'closedBy' in event.currentTarget) return;
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onCancel();
        }}>
        <header className="dialog-header"><h2 id={titleId} className="dialog-title">{title}</h2>{tools}</header>
        <div className="dialog-content">{children}</div>
        <div className="dialog-actions">{actions}</div>
    </dialog>, document.getElementById('app-overlays')!);
}
