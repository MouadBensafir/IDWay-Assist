import { useCallback, useEffect, useRef, useState } from "react";
import * as Speech from "expo-speech";
import type { Voice } from "expo-speech";
import {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionModule,
  ExpoSpeechRecognitionResultEvent,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

type VoiceLoopArgs = {
  onUtterance: (text: string) => Promise<string>;
  onBargeIn: () => void;
  selectedVoice: Voice | null;
};

export type VoiceStatus = "idle" | "listening" | "processing" | "speaking" | "error";

export function useVoiceLoop({ onUtterance, onBargeIn, selectedVoice }: VoiceLoopArgs) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState("");

  const transcriptRef = useRef("");
  const statusRef = useRef<VoiceStatus>("idle");

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const startListening = useCallback(async () => {
    try {
      const perms = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perms.granted) {
        setError("Microphone permission denied.");
        return;
      }
      transcriptRef.current = "";
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: false,
        continuous: false,
        maxAlternatives: 1,
      });
      setStatus("listening");
    } catch {
      setError("Cannot start speech recognition.");
      setStatus("error");
    }
  }, []);

  const stopListening = useCallback(() => {
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // no-op
    }
  }, []);

  const speakAndResume = useCallback(async (text: string) => {
    if (!text.trim()) {
      await startListening();
      return;
    }

    await Speech.stop().catch(() => undefined);
    setStatus("speaking");

    Speech.speak(text, {
      voice: selectedVoice?.identifier || undefined,
      onDone: () => {
        startListening();
      },
      onStopped: () => {
        startListening();
      },
      onError: () => {
        setError("TTS playback failed.");
        startListening();
      },
    });
  }, [selectedVoice, startListening]);

  const toggleListening = useCallback(() => {
    if (statusRef.current === "listening") {
      stopListening();
      setStatus("idle");
      return;
    }
    startListening();
  }, [startListening, stopListening]);

  useSpeechRecognitionEvent("start", () => {
    if (statusRef.current === "speaking" || statusRef.current === "processing") {
      onBargeIn();
      setStatus("listening");
    }
  });

  useSpeechRecognitionEvent("result", (e: ExpoSpeechRecognitionResultEvent) => {
    const t = e.results[0]?.transcript?.trim();
    if (!t) return;
    transcriptRef.current = t;
  });

  useSpeechRecognitionEvent("end", async () => {
    if (statusRef.current !== "listening") return;
    const text = transcriptRef.current.trim();
    if (!text) {
      await startListening();
      return;
    }

    setStatus("processing");
    stopListening();
    const reply = await onUtterance(text);
    await speakAndResume(reply);
  });

  useSpeechRecognitionEvent("error", (e: ExpoSpeechRecognitionErrorEvent) => {
    setError(e.message || "Speech recognition error.");
    setStatus("error");
  });

  return {
    status,
    error,
    setError,
    startListening,
    stopListening,
    toggleListening,
    speakAndResume,
    setStatus,
  };
}
