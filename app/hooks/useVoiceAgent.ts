import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import * as Speech from "expo-speech";

export type VoiceAgentState = "IDLE" | "LISTENING" | "PROCESSING" | "SPEAKING";

export type VoiceHistoryItem =
  | { role: "user"; text: string; timestamp: number }
  | { role: "assistant"; text: string; timestamp: number };

export type AudioSample = {
  energy: number;
  durationMs: number;
  chunk?: unknown;
};

export type SttResult = {
  transcript: string;
};

export type StreamAssistantParams = {
  prompt: string;
  history: VoiceHistoryItem[];
  signal: AbortSignal;
  onTextChunk: (chunk: string) => void;
};

export type UseVoiceAgentOptions = {
  vadThreshold: number;
  bargeInMs?: number;
  silenceWindowMs?: number;
  speechLanguage?: string;
  speechVoiceId?: string;
  transcribeAudio: (audioChunks: unknown[]) => Promise<SttResult>;
  streamAssistantResponse: (params: StreamAssistantParams) => Promise<void>;
  sanitizeForSpeech?: (text: string) => string;
};

export type UseVoiceAgentResult = {
  state: VoiceAgentState;
  history: VoiceHistoryItem[];
  liveTranscript: string;
  partialAssistantText: string;
  error: string;
  pushAudioSample: (sample: AudioSample) => Promise<void>;
  submitTranscript: (transcript: string) => Promise<void>;
  abortTurn: () => Promise<void>;
  resetConversation: () => Promise<void>;
  ttsQueueRef: MutableRefObject<string[]>;
  textBufferRef: MutableRefObject<string>;
};

const DEFAULT_BARGE_IN_MS = 300;
const DEFAULT_SILENCE_WINDOW_MS = 850;
const SENTENCE_BOUNDARY_REGEX = /(?<=[.!?\n])\s+/;

export function useVoiceAgent(
  options: UseVoiceAgentOptions
): UseVoiceAgentResult {
  const {
    vadThreshold,
    bargeInMs = DEFAULT_BARGE_IN_MS,
    silenceWindowMs = DEFAULT_SILENCE_WINDOW_MS,
    speechLanguage,
    speechVoiceId,
    transcribeAudio,
    streamAssistantResponse,
    sanitizeForSpeech = defaultSanitizeForSpeech,
  } = options;

  const [state, setState] = useState<VoiceAgentState>("IDLE");
  const [history, setHistory] = useState<VoiceHistoryItem[]>([]);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [partialAssistantText, setPartialAssistantText] = useState("");
  const [error, setError] = useState("");

  const stateRef = useRef<VoiceAgentState>("IDLE");
  const historyRef = useRef<VoiceHistoryItem[]>([]);
  const capturedAudioChunksRef = useRef<unknown[]>([]);
  const ttsQueueRef = useRef<string[]>([]);
  const textBufferRef = useRef("");
  const llmAbortControllerRef = useRef<AbortController | null>(null);
  const speakingRef = useRef(false);
  const streamClosedRef = useRef(false);
  const speakingChunkRef = useRef("");
  const highEnergyMsRef = useRef(0);
  const lowEnergyMsRef = useRef(0);

  const transitionTo = useCallback((nextState: VoiceAgentState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const clearTurnBuffers = useCallback(() => {
    capturedAudioChunksRef.current = [];
    ttsQueueRef.current = [];
    textBufferRef.current = "";
    streamClosedRef.current = false;
    speakingChunkRef.current = "";
    highEnergyMsRef.current = 0;
    lowEnergyMsRef.current = 0;
    speakingRef.current = false;
  }, []);

  const finalizeSpeakingIfDone = useCallback(() => {
    if (
      stateRef.current === "SPEAKING" &&
      streamClosedRef.current &&
      !textBufferRef.current.trim() &&
      ttsQueueRef.current.length === 0 &&
      !speakingRef.current
    ) {
      transitionTo("IDLE");
    }
  }, [transitionTo]);

  const drainTtsQueue = useCallback(() => {
    if (speakingRef.current) {
      return;
    }

    const nextSentence = ttsQueueRef.current.shift();
    if (!nextSentence) {
      finalizeSpeakingIfDone();
      return;
    }

    const speakableText = sanitizeForSpeech(nextSentence).trim();
    if (!speakableText) {
      drainTtsQueue();
      return;
    }

    speakingRef.current = true;
    speakingChunkRef.current = speakableText;
    transitionTo("SPEAKING");

    Speech.speak(speakableText, {
      language: speechLanguage,
      voice: speechVoiceId,
      onDone: () => {
        speakingRef.current = false;
        speakingChunkRef.current = "";
        drainTtsQueue();
      },
      onStopped: () => {
        speakingRef.current = false;
        speakingChunkRef.current = "";
        drainTtsQueue();
      },
      onError: () => {
        speakingRef.current = false;
        speakingChunkRef.current = "";
        setError("Text-to-speech playback failed.");
        finalizeSpeakingIfDone();
      },
    });
  }, [
    finalizeSpeakingIfDone,
    sanitizeForSpeech,
    speechLanguage,
    speechVoiceId,
    transitionTo,
  ]);

  const flushTextBufferToQueue = useCallback(
    (force: boolean) => {
      const normalized = textBufferRef.current.replace(/\r/g, "");
      if (!normalized.trim()) {
        textBufferRef.current = "";
        if (force) {
          drainTtsQueue();
        }
        return;
      }

      const segments = normalized.split(SENTENCE_BOUNDARY_REGEX);
      const hasBoundary = segments.length > 1;
      const completeSentences = hasBoundary
        ? segments.slice(0, -1)
        : force
          ? segments
          : [];
      const remainder = hasBoundary ? segments[segments.length - 1] ?? "" : force ? "" : normalized;

      completeSentences
        .map((sentence) => sentence.trim())
        .filter(Boolean)
        .forEach((sentence) => {
          ttsQueueRef.current.push(sentence);
        });

      textBufferRef.current = remainder;

      if (ttsQueueRef.current.length > 0 && stateRef.current === "PROCESSING") {
        transitionTo("SPEAKING");
      }

      if (ttsQueueRef.current.length > 0) {
        drainTtsQueue();
        return;
      }

      if (force) {
        finalizeSpeakingIfDone();
      }
    },
    [drainTtsQueue, finalizeSpeakingIfDone, transitionTo]
  );

  const abortTurn = useCallback(async () => {
    llmAbortControllerRef.current?.abort();
    llmAbortControllerRef.current = null;
    ttsQueueRef.current = [];
    textBufferRef.current = "";
    streamClosedRef.current = true;
    highEnergyMsRef.current = 0;
    lowEnergyMsRef.current = 0;
    speakingRef.current = false;
    speakingChunkRef.current = "";
    await Speech.stop().catch(() => undefined);
    transitionTo("IDLE");
  }, [transitionTo]);

  const processTranscript = useCallback(
    async (transcript: string) => {
      const cleanedTranscript = transcript.trim();
      if (!cleanedTranscript) {
        transitionTo("IDLE");
        return;
      }

      const nextUserItem: VoiceHistoryItem = {
        role: "user",
        text: cleanedTranscript,
        timestamp: Date.now(),
      };

      const nextHistory = [...historyRef.current, nextUserItem];
      historyRef.current = nextHistory;
      setHistory(nextHistory);
      setLiveTranscript(cleanedTranscript);
      setPartialAssistantText("");
      setError("");
      transitionTo("PROCESSING");

      const abortController = new AbortController();
      llmAbortControllerRef.current = abortController;
      textBufferRef.current = "";
      ttsQueueRef.current = [];
      streamClosedRef.current = false;
      let assistantAccumulator = "";

      try {
        await streamAssistantResponse({
          prompt: cleanedTranscript,
          history: nextHistory,
          signal: abortController.signal,
          onTextChunk: (chunk) => {
            if (!chunk) {
              return;
            }

            assistantAccumulator += chunk;
            setPartialAssistantText((current) => current + chunk);
            textBufferRef.current += chunk;
            flushTextBufferToQueue(false);
          },
        });

        streamClosedRef.current = true;
        flushTextBufferToQueue(true);

        const finalAssistantText = assistantAccumulator.trim();
        if (finalAssistantText) {
          const nextAssistantItem: VoiceHistoryItem = {
            role: "assistant",
            text: finalAssistantText,
            timestamp: Date.now(),
          };
          const updatedHistory = [...historyRef.current, nextAssistantItem];
          historyRef.current = updatedHistory;
          setHistory(updatedHistory);
        }

        if (!ttsQueueRef.current.length && !speakingRef.current) {
          transitionTo("IDLE");
        }
      } catch (caughtError) {
        if (abortController.signal.aborted) {
          transitionTo("LISTENING");
          return;
        }
        streamClosedRef.current = true;
        setError(getErrorMessage(caughtError, "Streaming assistant response failed."));
        transitionTo("IDLE");
      } finally {
        llmAbortControllerRef.current = null;
      }
    },
    [flushTextBufferToQueue, streamAssistantResponse, transitionTo]
  );

  const submitTranscript = useCallback(
    async (transcript: string) => {
      await processTranscript(transcript);
    },
    [processTranscript]
  );

  const completeCapturedSpeech = useCallback(async () => {
    transitionTo("PROCESSING");
    setError("");

    try {
      const sttResult = await transcribeAudio(capturedAudioChunksRef.current);
      capturedAudioChunksRef.current = [];
      await processTranscript(sttResult.transcript);
    } catch (caughtError) {
      capturedAudioChunksRef.current = [];
      setError(getErrorMessage(caughtError, "Speech transcription failed."));
      transitionTo("IDLE");
    }
  }, [processTranscript, transcribeAudio, transitionTo]);

  const pushAudioSample = useCallback(
    async (sample: AudioSample) => {
      const isAboveThreshold = sample.energy > vadThreshold;

      if (stateRef.current === "SPEAKING") {
        highEnergyMsRef.current = isAboveThreshold
          ? highEnergyMsRef.current + sample.durationMs
          : 0;

        if (highEnergyMsRef.current >= bargeInMs) {
          await abortTurn();
          capturedAudioChunksRef.current = sample.chunk ? [sample.chunk] : [];
          lowEnergyMsRef.current = 0;
          highEnergyMsRef.current = 0;
          transitionTo("LISTENING");
        }
        return;
      }

      if (stateRef.current === "IDLE" && isAboveThreshold) {
        clearTurnBuffers();
        transitionTo("LISTENING");
        if (sample.chunk !== undefined) {
          capturedAudioChunksRef.current.push(sample.chunk);
        }
        highEnergyMsRef.current = sample.durationMs;
        lowEnergyMsRef.current = 0;
        return;
      }

      if (stateRef.current !== "LISTENING") {
        return;
      }

      if (sample.chunk !== undefined) {
        capturedAudioChunksRef.current.push(sample.chunk);
      }

      if (isAboveThreshold) {
        lowEnergyMsRef.current = 0;
        highEnergyMsRef.current += sample.durationMs;
        return;
      }

      highEnergyMsRef.current = 0;
      lowEnergyMsRef.current += sample.durationMs;

      if (lowEnergyMsRef.current >= silenceWindowMs) {
        lowEnergyMsRef.current = 0;
        await completeCapturedSpeech();
      }
    },
    [
      abortTurn,
      bargeInMs,
      clearTurnBuffers,
      completeCapturedSpeech,
      silenceWindowMs,
      transitionTo,
      vadThreshold,
    ]
  );

  const resetConversation = useCallback(async () => {
    await abortTurn();
    clearTurnBuffers();
    historyRef.current = [];
    setHistory([]);
    setLiveTranscript("");
    setPartialAssistantText("");
    setError("");
    transitionTo("IDLE");
  }, [abortTurn, clearTurnBuffers, transitionTo]);

  useEffect(() => {
    return () => {
      llmAbortControllerRef.current?.abort();
      Speech.stop().catch(() => undefined);
    };
  }, []);

  return {
    state,
    history,
    liveTranscript,
    partialAssistantText,
    error,
    pushAudioSample,
    submitTranscript,
    abortTurn,
    resetConversation,
    ttsQueueRef,
    textBufferRef,
  };
}

function defaultSanitizeForSpeech(text: string) {
  return text
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/[.?!]+/g, " ")
    .replace(/[,;:]+/g, ", ")
    .replace(/[()[\]{}"']/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return `${fallback} ${error.message}`;
  }

  if (typeof error === "string" && error.trim()) {
    return `${fallback} ${error}`;
  }

  return fallback;
}
