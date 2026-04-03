import { Component, type ReactNode, type ErrorInfo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, RefreshCw, LogOut } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error("[ErrorBoundary] Caught render error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset?.();
  };

  handleSignOut = () => {
    localStorage.clear();
    window.location.href = "/signin";
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return <ErrorFallbackScreen error={this.state.error} onReset={this.handleReset} onSignOut={this.handleSignOut} />;
    }

    return this.props.children;
  }
}

function ErrorFallbackScreen({ error, onReset, onSignOut }: { error: Error | null; onReset: () => void; onSignOut: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
      <Card className="w-full max-w-lg border-destructive/50">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 text-destructive" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground mb-1">Syncoree failed to load</h1>
              <p className="text-sm text-muted-foreground">
                An unexpected error occurred during rendering. This is usually caused by a configuration issue or a session problem.
              </p>
            </div>
            {error && (
              <div className="w-full bg-destructive/5 border border-destructive/20 rounded-lg p-3 text-left">
                <p className="text-xs font-mono text-destructive break-all">
                  {error.name}: {error.message}
                </p>
              </div>
            )}
            <div className="flex gap-3 flex-wrap justify-center">
              <Button onClick={onReset} variant="default">
                <RefreshCw className="w-4 h-4 mr-2" />
                Try Again
              </Button>
              <Button onClick={onSignOut} variant="outline">
                <LogOut className="w-4 h-4 mr-2" />
                Sign Out
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              If the problem persists, check your browser console for details.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
