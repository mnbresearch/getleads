import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last line of defence against a white screen.
 *
 * Without a boundary, one component throwing during render unmounts the whole tree: the user
 * sees an empty page with no message and no way forward but guessing to reload. This shows
 * what broke and offers the reload. `resetKey` (the route) lets navigating away recover
 * without a full reload when only one page is broken.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render crash", error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-cream p-6">
        <div className="card max-w-md p-6 text-center" role="alert">
          <div className="text-lg font-semibold text-ink-50">Something went wrong - reload</div>
          <p className="mt-2 text-sm text-ink-400">This screen hit an error and could not finish drawing. Your data is safe; reloading usually clears it.</p>
          {error.message && <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-black/[0.04] p-3 text-left text-xs text-ink-300">{error.message}</pre>}
          <div className="mt-4 flex justify-center gap-2">
            <button className="btn-primary" onClick={() => window.location.reload()}>Reload</button>
            <button className="btn-secondary" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      </div>
    );
  }
}
