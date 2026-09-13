import { SpeechRecognition } from "@capgo/capacitor-speech-recognition";
import { useCallback, useEffect, useRef, useState } from "react";

import { isNative } from "@m/lib/native";

/**
 * On-device dictation (SFSpeechRecognizer / Android SpeechRecognizer). Nothing is uploaded
 * and it works without signal. The transcript is always editable before it is used — raw
 * recognizer output never becomes a record on its own.
 */

/** Trade vocabulary the recognizer otherwise mishears. */
const CONTEXTUAL_STRINGS = [
  "shrink wrap",
  "winterization",
  "winterize",
  "bimini",
  "haul-out",
  "outboard",
  "sterndrive",
  "inboard",
  "gelcoat",
  "ceramic coating",
  "graphene",
  "bottom paint",
  "travel lift",
  "slip",
  "marina",
  "Jobber",
  "Marina",
];

export function useDictation() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!isNative) {
      setSupported(false);
      return;
    }
    void SpeechRecognition.available()
      .then(({ available }) => setSupported(available))
      .catch(() => setSupported(false));

    const partial = SpeechRecognition.addListener("partialResults", (event) => {
      const text = event.accumulatedText ?? event.matches?.[0];
      if (text) setTranscript(text);
    });
    const state = SpeechRecognition.addListener("listeningState", (event) => {
      const stopped = event.state === "stopped" || event.status === "stopped";
      const started = event.state === "started" || event.status === "started";
      if (started) setListening(true);
      if (stopped) {
        setListening(false);
        startedAt.current = null;
      }
    });
    const failure = SpeechRecognition.addListener("error", (event) => {
      setListening(false);
      setError(event.message || "Dictation stopped unexpectedly.");
    });

    return () => {
      void partial.then((h) => h.remove());
      void state.then((h) => h.remove());
      void failure.then((h) => h.remove());
      void SpeechRecognition.stop().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!listening) return;
    const timer = setInterval(() => {
      if (startedAt.current) setElapsed(Math.round((Date.now() - startedAt.current) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [listening]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const permission = await SpeechRecognition.requestPermissions();
      if (permission.speechRecognition !== "granted") {
        setError("Microphone and speech recognition access are off. Turn them on in Settings.");
        return;
      }
      startedAt.current = Date.now();
      setElapsed(0);
      setListening(true);
      await SpeechRecognition.start({
        language: "en-CA",
        partialResults: true,
        popup: false,
        maxResults: 1,
        addPunctuation: true,
        contextualStrings: CONTEXTUAL_STRINGS,
      });
    } catch (err) {
      setListening(false);
      setError(err instanceof Error ? err.message : "Dictation failed.");
    }
  }, []);

  const stop = useCallback(async () => {
    await SpeechRecognition.stop().catch(() => undefined);
    setListening(false);
  }, []);

  return { supported, listening, transcript, setTranscript, error, elapsed, start, stop };
}
