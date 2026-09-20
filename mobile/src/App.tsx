import { App as CapApp } from "@capacitor/app";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { useEffect, useRef, useState } from "react";

import { missingEnv } from "@m/lib/env";
import { isNative } from "@m/lib/native";
import { AcceptInvite } from "@m/screens/auth/AcceptInvite";
import { ForgotPassword } from "@m/screens/auth/ForgotPassword";
import { Onboarding } from "@m/screens/auth/Onboarding";
import { PhoneAuth } from "@m/screens/auth/PhoneAuth";
import { SignIn } from "@m/screens/auth/SignIn";
import { SignUp } from "@m/screens/auth/SignUp";
import { UpdatePassword } from "@m/screens/auth/UpdatePassword";
import { Shell } from "@m/Shell";
import { DeviceProvider } from "@m/state/device";
import { NavProvider } from "@m/state/nav";
import { ScopeProvider } from "@m/state/scope";
import { SessionProvider, useSession } from "@m/state/session";
import { Btn, ErrorBanner } from "@m/ui/kit";
import { ToastProvider } from "@m/ui/toast";

export function App() {
  return (
    <DeviceProvider>
      <ToastProvider>
        <SessionProvider>
          <Gate />
        </SessionProvider>
      </ToastProvider>
    </DeviceProvider>
  );
}

export type AuthRoute = "signin" | "signup" | "phone" | "forgot";

function Gate() {
  const session = useSession();
  const [authRoute, setAuthRoute] = useState<AuthRoute>("signin");

  useEffect(() => {
    if (!isNative) return;
    void StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
  }, []);

  // Android hardware back on the signed-out screens. NavProvider's listener only exists inside
  // the signed-in tree, so without this back is a dead key on Sign up, Phone and Forgot password.
  const authBack = useRef<{ owns: boolean; route: AuthRoute }>({ owns: false, route: "signin" });
  authBack.current = { owns: session.status !== "signedIn", route: authRoute };
  useEffect(() => {
    if (!isNative) return;
    const handle = CapApp.addListener("backButton", () => {
      if (!authBack.current.owns) return;
      if (authBack.current.route !== "signin") setAuthRoute("signin");
      else void CapApp.minimizeApp();
    });
    return () => {
      void handle.then((h) => h.remove());
    };
  }, []);

  const settled = session.status !== "loading" && !(session.status === "signedIn" && session.context.isPending);
  useEffect(() => {
    if (settled && isNative) void SplashScreen.hide({ fadeOutDuration: 200 });
  }, [settled]);

  if (missingEnv.length > 0) {
    return (
      <AuthFrame>
        <div className="h2">App not configured</div>
        <p className="muted-p">This build is missing {missingEnv.join(", ")}. Set them in mobile/.env and rebuild.</p>
      </AuthFrame>
    );
  }

  if (session.status === "loading") return <div className="app" />;

  if (session.recovery.active) {
    return (
      <AuthFrame>
        <UpdatePassword />
      </AuthFrame>
    );
  }

  if (session.status !== "signedIn") {
    return (
      <AuthFrame>
        {authRoute === "signup" ? (
          <SignUp go={setAuthRoute} />
        ) : authRoute === "phone" ? (
          <PhoneAuth go={setAuthRoute} />
        ) : authRoute === "forgot" ? (
          <ForgotPassword go={setAuthRoute} />
        ) : (
          <SignIn go={setAuthRoute} locked={session.status === "locked"} />
        )}
      </AuthFrame>
    );
  }

  if (session.context.isPending) return <div className="app" />;

  // Only when there is nothing cached to show. A failed *refetch* (resume on a dead connection,
  // an invalidation after a push) must not replace a working app with a full-screen error and
  // reset the navigation stack — the screens surface their own errors over cached content.
  if (session.context.isLoadingError || (session.context.isError && !session.context.data)) {
    return (
      <AuthFrame>
        <div className="h2">Can't reach EmpireVu</div>
        <ErrorBanner error={session.context.error} onRetry={() => void session.context.refetch()} />
        <Btn variant="secondary" size="md" block onClick={() => void session.signOut()}>
          Sign out
        </Btn>
      </AuthFrame>
    );
  }

  if (!session.context.data) return <div className="app" />;

  if (session.inviteToken) {
    return (
      <AuthFrame>
        <AcceptInvite token={session.inviteToken} />
      </AuthFrame>
    );
  }

  if (session.context.data.organizations.length === 0) {
    return (
      <AuthFrame>
        <Onboarding />
      </AuthFrame>
    );
  }

  return (
    <ScopeProvider context={session.context.data}>
      <NavProvider>
        <Shell />
      </NavProvider>
    </ScopeProvider>
  );
}

function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <div className="statusbar-spacer" />
      <div className="scroll">
        <div className="page full" style={{ paddingBottom: "calc(28px + var(--safe-bottom))" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
