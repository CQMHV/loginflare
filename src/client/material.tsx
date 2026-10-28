import { createElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type PropsWithChildren, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import '@material/web/button/filled-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/checkbox/checkbox.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
import '@material/web/progress/circular-progress.js';
import '@material/web/dialog/dialog.js';
import '@material/web/menu/menu.js';
import '@material/web/menu/menu-item.js';
import type { MdDialog } from '@material/web/dialog/dialog.js';
import type { MdMenu } from '@material/web/menu/menu.js';
import type { Locale } from '../shared/locales';
import type { ThemePreference } from './theme';

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

export function ButtonLink({ children, to, className = '' }: PropsWithChildren<{ to: string; className?: string }>) {
    const navigate = useNavigate();
    return createElement('md-filled-button', {
        href: to, className,
        onClick: (event: MouseEvent) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate(to);
        },
    }, children);
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

export function LanguageSelect({ label, value, onChange }: { label: string; value: Locale; onChange: (locale: Locale) => void }) {
    return createElement('md-outlined-select', {
        value, className: 'language-select', 'aria-label': label,
        onChange: (event: Event) => onChange((event.currentTarget as HTMLElement & { value: Locale }).value),
    }, ...([{ value: 'en-US', label: 'English' }, { value: 'zh-CN', label: '简体中文' }]).map((option) =>
        createElement('md-select-option', { key: option.value, value: option.value }, <div slot="headline">{option.label}</div>)));
}

export function Select({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
    return createElement('md-outlined-select', {
        value, label, 'aria-label': label,
        onChange: (event: Event) => onChange((event.currentTarget as HTMLElement & { value: string }).value),
    }, ...options.map((option) => createElement('md-select-option', { key: option.value, value: option.value }, <div slot="headline">{option.label}</div>)));
}

export function ThemeMenu({ label, currentLabel, icon, options, onChange }: {
    label: string; currentLabel: string; icon: ReactNode;
    options: { value: ThemePreference; label: string; selected: boolean; icon: ReactNode }[];
    onChange: (value: ThemePreference) => void;
}) {
    const id = useId();
    const menu = useRef<MdMenu>(null);
    const [open, setOpen] = useState(false);
    return <div className="theme-control">
        <Button id={id} className="icon-button" aria-label={label} title={`${label}: ${currentLabel}`} aria-haspopup="menu" aria-expanded={open ? 'true' : 'false'} onClick={() => { if (menu.current) menu.current.open = !menu.current.open; }}>{icon}</Button>
        {createElement('md-menu', { ref: menu, anchor: id, 'aria-label': label, anchorCorner: 'end-end', menuCorner: 'start-end', onopening: () => setOpen(true), onclosing: () => setOpen(false) },
            ...options.map((option) => createElement('md-menu-item', {
                key: option.value, 'aria-current': option.selected ? 'true' : undefined,
                onClick: () => onChange(option.value),
            }, <div slot="headline">{option.label}</div>, <span slot="start">{option.icon}</span>, option.selected && <svg slot="end" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41Z" /></svg>)),
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
