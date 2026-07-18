import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureError } from '../services/monitoring';

// Top-level React error boundary (path-forward §0.3). A render/lifecycle throw
// used to unmount the whole tree — an installed-PWA user just saw a white
// screen with no reload button and no report. Now the error is captured
// (Sentry when configured) and the user gets a minimal zen-styled recovery
// screen. State/localStorage are untouched: reload resumes where they were.
export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    captureError(error, { componentStack: info.componentStack, boundary: 'root' });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1.25rem',
          padding: '2rem',
          backgroundColor: 'var(--bg-color)',
          color: 'var(--text-main)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontFamily: "'Shippori Mincho', serif", fontSize: '1.6rem' }}>侘寂</div>
        <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', maxWidth: '26rem', lineHeight: 1.6 }}>
          Something broke. Your reading progress is safe.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '0.7rem 1.6rem',
            borderRadius: '14px',
            border: '1px solid var(--border-light)',
            backgroundColor: 'var(--bg-card)',
            color: 'var(--text-main)',
            fontSize: '0.9rem',
            cursor: 'pointer',
          }}
        >
          再読み込み — Reload
        </button>
      </div>
    );
  }
}
