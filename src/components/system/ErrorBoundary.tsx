import { Component, useEffect, type ReactNode, type ErrorInfo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, RefreshCw, LogOut } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
  onSignOut?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  errorId: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, errorId: "" };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
      errorId: `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error("[ErrorBoundary] Caught render error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, errorId: "" });
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
      return (
        <ErrorFallbackScreen
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          errorId={this.state.errorId}
          onReset={this.handleReset}
          onSignOut={this.props.onSignOut ?? this.handleSignOut}
        />
      );
    }

    return this.props.children;
  }
}

function ErrorFallbackScreen({
  error,
  errorInfo,
  errorId,
  onReset,
  onSignOut,
}: {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  errorId: string;
  onReset: () => void;
  onSignOut: () => void;
}) {
  const errorMessage = error?.message || "An unknown error occurred";
  const isAuthError =
    errorMessage.includes("401") ||
    errorMessage.includes("403") ||
    errorMessage.includes("unauthenticated") ||
    errorMessage.includes("Unauthorized");

  const isNetworkError =
    errorMessage.includes("fetch") ||
    errorMessage.includes("network") ||
    errorMessage.includes("Failed to fetch") ||
    errorMessage.includes("NetworkError");

  let userMessage = "An unexpected error occurred during rendering. This is usually caused by a configuration issue or a session problem.";
  let suggestedAction = "Try Again";

  if (isAuthError) {
    userMessage = "Your session may have expired or you don't have access to this resource.";
    suggestedAction = "Sign In Again";
  } else if (isNetworkError) {
    userMessage = "Unable to connect to the server. Please check your internet connection.";
    suggestedAction = "Retry";
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
      <Card className="w-full max-w-lg border-destructive/50">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 text-destructive" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground mb-1">EmpireVu failed to load</h1>
              <p className="text-sm text-muted-foreground">{userMessage}</p>
            </div>
            {error && (
              <div className="w-full bg-destructive/5 border border-destructive/20 rounded-lg p-3 text-left">
                <p className="text-xs font-mono text-destructive break-all">
                  {error.name}: {error.message}
                </p>
              </div>
            )}
            {errorInfo?.componentStack && (
              <details className="w-full text-left">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                  Technical Details
                </summary>
                <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto max-h-32 text-muted-foreground">
                  {errorInfo.componentStack}
                </pre>
              </details>
            )}
            <div className="flex gap-3 flex-wrap justify-center">
              <Button onClick={onReset} variant="default">
                <RefreshCw className="w-4 h-4 mr-2" />
                {suggestedAction}
              </Button>
              <Button onClick={onSignOut} variant="outline">
                <LogOut className="w-4 h-4 mr-2" />
                Sign Out
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Error ID: {errorId}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function GlobalErrorHandler({ children }: { children: ReactNode }) {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error("[GlobalErrorHandler] Uncaught error:", event.error);
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error("[GlobalErrorHandler] Unhandled promise rejection:", event.reason);
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  return <>{children}</>;
}
