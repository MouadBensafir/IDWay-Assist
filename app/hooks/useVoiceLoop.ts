import { useCallback, useEffect, useRef, useState } from "react";
import * as Speech from "expo-speech";
import {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionModule,
  ExpoSpeechRecognitionResultEvent,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

type VoiceLoopArgs = {
  language: string;
  voiceId?: string;
  autoLoop?: boolean;
  onUserFinalText: (text: string) => Promise<void>;
  onBargeIn?: () => void;
};

export function useVoiceLoop({
  language,
  voiceId,
  autoLoop = true,
  onUserFinalText,
  onBargeIn,
}: VoiceLoopArgs) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [error, setError] = useState("");

  const shouldSubmitOnEndRef = useRef(false);

  useSpeechRecognitionEvent("start", () => {
    setError("");
    setIsListening(true);
    if (isSpeaking) {
      void Speech.stop();
    }
    onBargeIn?.();
  });

  useSpeechRecognitionEvent("result", (event: ExpoSpeechRecognitionResultEvent) => {
    const text = event.results[0]?.transcript?.trim() ?? "";
    if (!text) {
      return;
    }

    setPartialTranscript(text);
    if (event.isFinal) {
      setFinalTranscript(text);
    }
  });

  useSpeechRecognitionEvent("error", (event: ExpoSpeechRecognitionErrorEvent) => {
    shouldSubmitOnEndRef.current = false;
    setIsListening(false);
    setError(event.message || "Speech recognition failed.");
  });

  useSpeechRecognitionEvent("end", () => {
    setIsListening(false);
    const shouldSubmit = shouldSubmitOnEndRef.current;
    shouldSubmitOnEndRef.current = false;
    if (!shouldSubmit) {
      return;
    }

    const spoken = (finalTranscript || partialTranscript).trim();
    if (!spoken) {
      setError("No speech captured.");
      return;
    }

    void onUserFinalText(spoken);
  });

  const startListening = useCallback(async () => {
    setError("");
    setPartialTranscript("");
    setFinalTranscript("");
    shouldSubmitOnEndRef.current = true;

    const permissions = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permissions.granted) {
      setError("Microphone permission denied.");
      return;
    }

    ExpoSpeechRecognitionModule.start({
      lang: language,
      interimResults: true,
      continuous: false,
      maxAlternatives: 1,
      androidIntentOptions: {
        EXTRA_LANGUAGE_MODEL: "free_form",
      },
    });
  }, [language]);

  const stopListening = useCallback(() => {
    shouldSubmitOnEndRef.current = false;
    ExpoSpeechRecognitionModule.abort();
    setIsListening(false);
  }, []);

  const toggleListening = useCallback(async () => {
    if (isListening) {
      stopListening();
      return;
    }
    await startListening();
  }, [isListening, startListening, stopListening]);

  const speakText = useCallback(
    async (text: string) => {
      if (!text.trim()) {
        return;
      }
      await Speech.stop();
      setIsSpeaking(true);

      return new Promise<void>((resolve) => {
        Speech.speak(text, {
          language,
          voice: voiceId || undefined,
          onDone: () => {
            setIsSpeaking(false);
            if (autoLoop) {
              void startListening();
            }
            resolve();
          },
          onStopped: () => {
            setIsSpeaking(false);
            resolve();
          },
          onError: () => {
            setIsSpeaking(false);
            setError("Unable to play assistant speech.");
            resolve();
          },
        });
      });
    },
    [autoLoop, language, startListening, voiceId]
  );

  const stopSpeaking = useCallback(async () => {
    await Speech.stop();
    setIsSpeaking(false);
  }, []);

  useEffect(() => {
    return () => {
      ExpoSpeechRecognitionModule.abort();
      void Speech.stop();
    };
  }, []);

  return {
    isListening,
    isSpeaking,
    partialTranscript,
    finalTranscript,
    error,
    startListening,
    stopListening,
    toggleListening,
    speakText,
    stopSpeaking,
    clearError: () => setError(""),
  };
}
