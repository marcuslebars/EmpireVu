import { App as CapApp } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { DEFAULT_PREFS, loadDevicePrefs, saveDevicePrefs, type DevicePrefs } from "@m/lib/native";
import { drainPhotoQueue } from "@m/lib/photoQueue";

interface DeviceValue {
  online: boolean;
  prefs: DevicePrefs;
  setPref: <K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]) => void;
}

const DeviceContext = createContext<DeviceValue>({ online: true, prefs: DEFAULT_PREFS, setPref: () => undefined });

export function DeviceProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
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

  // Sole owner of the photo queue. Draining from a booking screen only ever covered that
  // one booking, so photos taken against any other job sat there until it was reopened.
  useEffect(() => {
    if (!online) return;
    const drain = () =>
      void drainPhotoQueue().then((uploaded) => {
        if (uploaded > 0) void queryClient.invalidateQueries({ queryKey: ["photos"] });
      });
    drain();
    const handle = CapApp.addListener("resume", drain);
    return () => {
      void handle.then((h) => h.remove());
    };
  }, [online, queryClient]);

  const value = useMemo(() => ({ online, prefs, setPref }), [online, prefs, setPref]);
  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

export function useDevice(): DeviceValue {
  return useContext(DeviceContext);
}
