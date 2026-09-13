import { Network } from "@capacitor/network";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { DEFAULT_PREFS, loadDevicePrefs, saveDevicePrefs, type DevicePrefs } from "@m/lib/native";

interface DeviceValue {
  online: boolean;
  prefs: DevicePrefs;
  setPref: <K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]) => void;
}

const DeviceContext = createContext<DeviceValue>({ online: true, prefs: DEFAULT_PREFS, setPref: () => undefined });

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const [prefs, setPrefs] = useState<DevicePrefs>(DEFAULT_PREFS);

  useEffect(() => {
    void loadDevicePrefs().then(setPrefs);
    void Network.getStatus().then((status) => setOnline(status.connected));
    const handle = Network.addListener("networkStatusChange", (status) => setOnline(status.connected));
    return () => {
      void handle.then((h) => h.remove());
    };
  }, []);

  const setPref = useCallback(<K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      void saveDevicePrefs(next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("compact", prefs.compact);
  }, [prefs.compact]);

  const value = useMemo(() => ({ online, prefs, setPref }), [online, prefs, setPref]);
  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

export function useDevice(): DeviceValue {
  return useContext(DeviceContext);
}
