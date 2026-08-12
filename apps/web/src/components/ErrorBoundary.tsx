import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render error so one broken component does not blank the app.
 *
 * Placed around each sidebar tab and the board separately, not just at the
 * top: a single outer boundary still takes the whole table down, which is
 * barely better than the white page it replaces. A soundboard that throws
 * should cost you the soundboard.
 */
interface Props {
  children: ReactNode;
  /** Shown in the fallback, so it is obvious which piece failed. */
  label: string;
  /** Compact fallback for a panel; full-page for the router-level boundary. */
  variant?: 'panel' | 'page';
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console rather than swallowed; the stack is what makes the
    // difference between "it broke" and a fix.
    console.error(`[${this.props.label}] crashed`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.variant === 'page') {
      return (
        <div className="bg-vellum flex min-h-full items-center justify-center p-6">
          <div className="w-full max-w-md rounded-xl border border-red-900/60 bg-ink-900 p-6 text-center">
            <h1 className="font-display text-xl text-ink-100">Something broke</h1>
            <p className="mt-2 text-sm text-ink-400">
              {this.props.label} hit an error. Your campaign data is safe on the server — this is
              only the page.
            </p>
            <pre className="mt-3 max-h-32 overflow-auto rounded bg-ink-950 p-2 text-left text-[11px] text-red-300">
              {error.message}
            </pre>
            <div className="mt-4 flex justify-center gap-2">
              <button
                onClick={this.reset}
                className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm text-ink-200 hover:bg-ink-800"
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="rounded-lg bg-ember-500 px-3 py-1.5 text-sm font-semibold text-ink-950 hover:bg-ember-400"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-3">
        <p className="text-xs text-red-200">{this.props.label} stopped working.</p>
        <p className="mt-1 text-[10px] break-words text-red-300/70">{error.message}</p>
        <button
          onClick={this.reset}
          className="mt-2 rounded border border-red-800 px-2 py-1 text-[11px] text-red-200 hover:bg-red-900/40"
        >
          Try again
        </button>
      </div>
    );
  }
}
