import { Component, type PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './material';
import { ErrorNotice } from './feedback';

function PageLoadFailure() {
    const { t } = useTranslation();
    return <section className="card"><div className="card-body stack-form">
        <h1>{t('pageLoadTitle')}</h1><ErrorNotice message={t('pageLoadFailure')} />
        <Button onClick={() => window.location.reload()}>{t('reloadPage')}</Button>
    </div></section>;
}

/** A failed module stays rejected for this document; reload explicitly to retry it. */
export class PageBoundary extends Component<PropsWithChildren<{ resetKey: string }>, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidUpdate(previous: Readonly<PropsWithChildren<{ resetKey: string }>>) {
        if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
    }
    render() { return this.state.failed ? <PageLoadFailure /> : this.props.children; }
}
