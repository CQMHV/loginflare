import { createElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type PropsWithChildren, type ReactNode } from 'react';
import { NavLink, useNavigate, type NavLinkProps } from 'react-router-dom';
import '@material/web/button/filled-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/iconbutton/filled-tonal-icon-button.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/checkbox/checkbox.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
import '@material/web/progress/circular-progress.js';
import '@material/web/dialog/dialog.js';
import '@material/web/menu/menu.js';
import '@material/web/menu/menu-item.js';
import '@material/web/list/list.js';
import '@material/web/list/list-item.js';
import '@material/web/divider/divider.js';
import '@material/web/ripple/ripple.js';
import '@material/web/focus/md-focus-ring.js';
import type { MdDialog } from '@material/web/dialog/dialog.js';
import type { MdMenu } from '@material/web/menu/menu.js';
import type { CloseMenuEvent } from '@material/web/menu/internal/controllers/shared.js';

// React 19 assigns Web Component properties and subscribes to their native events.
// Keep the adapter small; rendering, form association and validation belong to Material Web.
export function Progress() {
    return createElement('md-circular-progress', { indeterminate: true, className: 'progress-indicator', 'aria-hidden': true });
}

export function Button({ children, busy, className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
    const tag = className.includes('icon-button') ? 'md-icon-button'
        : className.includes('text-button') ? 'md-text-button'
        : className.includes('secondary') ? 'md-outlined-button' : 'md-filled-button';
    return createElement(tag, { ...props, type, className, disabled: busy || props.disabled, 'aria-busy': busy || undefined }, busy && <Progress />, children);
}

export function ButtonLink({ children, to, className = '', variant = 'filled', ...props }: PropsWithChildren<{ to: string; className?: string; variant?: 'filled' | 'text' | 'icon'; 'aria-label'?: string }>) {
    const navigate = useNavigate();
    const tag = variant === 'icon' ? 'md-icon-button' : variant === 'text' ? 'md-text-button' : 'md-filled-button';
    return createElement(tag, {
        ...props, href: to, className,
        onClick: (event: MouseEvent) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate(to);
        },
    }, children);
}

export function NavigationLink({ children, ...props }: PropsWithChildren<Omit<NavLinkProps, 'children'>>) {
    return <NavLink {...props}>{createElement('md-ripple')}{createElement('md-focus-ring', { inward: true })}{children}</NavLink>;
}

export function Divider() {
    return createElement('md-divider');
}

export function List({ children, className, label }: PropsWithChildren<{ className?: string; label: string }>) {
    return createElement('md-list', { className, role: 'list', 'aria-label': label }, children);
}

export function ListItem({ headline, supportingText, start, end, className }: {
    headline: ReactNode; supportingText?: ReactNode; start?: ReactNode; end?: ReactNode; className?: string;
}) {
    return createElement('md-list-item', { className, type: 'text' },
        start && <span slot="start">{start}</span>,
        <div slot="headline">{headline}</div>,
        supportingText && <div slot="supporting-text">{supportingText}</div>,
        end && <div slot="end">{end}</div>,
    );
}

interface TextFieldProps {
    label: string;
    value: string;
    onValueChange?: (value: string) => void;
    type?: 'text' | 'email' | 'password' | 'textarea';
    name?: string;
    autoComplete?: string;
    inputMode?: 'text' | 'email' | 'numeric';
    placeholder?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    required?: boolean;
    readOnly?: boolean;
    supportingText?: string;
}

export function TextField({ label, onValueChange, supportingText, ...props }: TextFieldProps) {
    return createElement('md-outlined-text-field', {
        ...props, label, 'aria-label': label, supportingText,
        onInput: (event: Event) => onValueChange?.((event.currentTarget as HTMLElement & { value: string }).value),
    });
}

export function Checkbox({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
    return <label className="check-label">{createElement('md-checkbox', {
        checked, 'aria-label': label, 'touch-target': 'wrapper',
        onChange: (event: Event) => onCheckedChange((event.currentTarget as HTMLElement & { checked: boolean }).checked),
    })}<span>{label}</span></label>;
}

export function Select({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
    return createElement('md-outlined-select', {
        value, label, 'aria-label': label,
        onChange: (event: Event) => onChange((event.currentTarget as HTMLElement & { value: string }).value),
    }, ...options.map((option) => createElement('md-select-option', { key: option.value, value: option.value }, <div slot="headline">{option.label}</div>)));
}

export function MenuButton({ label, description, icon, options, onSelect, className = '', busy = false }: {
    label: string; description?: string; icon: ReactNode; className?: string; busy?: boolean;
    options: { value: string; label: string; selected?: boolean; icon?: ReactNode }[];
    onSelect: (value: string) => void;
}) {
    const id = useId();
    const menuId = `${id}-menu`;
    const menu = useRef<MdMenu>(null);
    const selection = useRef<string | undefined>(undefined);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        const element = menu.current;
        if (!element) return;
        const opening = () => { selection.current = undefined; setOpen(true); };
        const closing = () => setOpen(false);
        const select = (event: Event) => {
            const { reason, initiator } = (event as CloseMenuEvent).detail;
            if (reason.kind === 'click-selection' || (reason.kind === 'keydown' && ['Enter', 'Space'].includes(reason.key))) {
                selection.current = initiator.dataset.menuValue;
            }
        };
        const closed = () => {
            const value = selection.current;
            selection.current = undefined;
            if (value !== undefined) onSelect(value);
        };
        element.addEventListener('opening', opening);
        element.addEventListener('closing', closing);
        element.addEventListener('closed', closed);
        element.addEventListener('close-menu', select, true);
        return () => {
            element.removeEventListener('opening', opening);
            element.removeEventListener('closing', closing);
            element.removeEventListener('closed', closed);
            element.removeEventListener('close-menu', select, true);
        };
    }, [onSelect]);
    function show(last = false) {
        if (!menu.current) return;
        menu.current.defaultFocus = last ? 'last-item' : 'first-item';
        menu.current.show();
    }
    function keyDown(event: ReactKeyboardEvent<HTMLElement>) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            show(event.key === 'ArrowUp');
        }
    }
    const currentLabel = description ?? options.find((option) => option.selected)?.label;
    return <div className={`menu-control ${className}`}>
        {createElement('md-filled-tonal-icon-button', { id, type: 'button', 'aria-label': label, 'aria-description': currentLabel, title: currentLabel ? `${label}: ${currentLabel}` : label, 'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-controls': menuId, disabled: busy, 'aria-busy': busy || undefined,
            onClick: () => { if (menu.current?.open) menu.current.close(); else show(); }, onKeyDown: keyDown,
        }, icon)}
        {createElement('md-menu', { ref: menu, id: menuId, anchor: id, positioning: 'popover', 'aria-label': label, anchorCorner: 'end-end', menuCorner: 'start-end' },
            ...options.map((option) => createElement('md-menu-item', {
                key: option.value, type: 'button', 'data-menu-value': option.value, selected: Boolean(option.selected), 'aria-selected': option.selected ? 'true' : undefined,
            }, <div slot="headline">{option.label}</div>, option.icon && <span slot="start">{option.icon}</span>, option.selected && <svg slot="end" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41Z" /></svg>)),
        )}
    </div>;
}

export function ConfirmationDialog({ title, description, cancelLabel, confirmLabel, onCancel, onConfirm }: {
    title: string; description: string; cancelLabel: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void;
}) {
    const dialog = useRef<MdDialog>(null);
    const closing = useRef(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        void dialog.current?.show();
    }, []);
    async function close(callback: () => void) {
        if (closing.current) return;
        closing.current = true;
        setBusy(true);
        await dialog.current?.close();
        callback();
    }
    return createElement('md-dialog', { ref: dialog, 'aria-label': title, onCancel: (event: Event) => { event.preventDefault(); void close(onCancel); } },
        <div slot="headline">{title}</div>,
        <div slot="content">{description}</div>,
        <div slot="actions"><Button className="text-button" disabled={busy} onClick={() => { void close(onCancel); }}>{cancelLabel}</Button><Button className="text-button danger" disabled={busy} onClick={() => { void close(onConfirm); }}>{confirmLabel}</Button></div>,
    );
}
