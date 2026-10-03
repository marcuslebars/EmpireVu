import type { CapacitorConfig } from "@capacitor/cli";

/** hsl(222 20% 6%) — the app background, so launch and overscroll never flash white. */
const BACKGROUND = "#0c0e12";

const config: CapacitorConfig = {
  // Reverse-DNS bundle id. It is permanent once published to either store.
  appId: "com.empirevu.app",
  appName: "EmpireVu",
  webDir: "dist",
  backgroundColor: BACKGROUND,
  ios: {
    contentInset: "never",
    backgroundColor: BACKGROUND,
  },
  android: {
    backgroundColor: BACKGROUND,
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: BACKGROUND,
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: BACKGROUND,
      overlaysWebView: true,
    },
    Keyboard: {
      resize: "body",
      style: "DARK",
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
