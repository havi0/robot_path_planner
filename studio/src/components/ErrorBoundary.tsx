import { AlertTriangle } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "./ui/button";

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("UI error", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="panel max-w-md p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 h-6 w-6 text-warn" />
          <div className="text-[14px] font-semibold">This view crashed</div>
          <p className="mt-2 text-[12.5px] text-ink-3">The rest of the studio and the backend are unaffected. Robot and training state are kept on the server.</p>
          <pre className="mono mt-3 max-h-32 overflow-auto rounded-md bg-surface-2 p-2 text-left text-[11px] text-bad">{this.state.error.message}</pre>
          <Button className="mt-4" variant="secondary" onClick={() => this.setState({ error: null })}>Try again</Button>
        </div>
      </div>
    );
  }
}
