import { useIsFocused } from "@react-navigation/native";
import { Audio } from "expo-av";
import Constants from "expo-constants";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import type { Voice } from "expo-speech";
import * as Speech from "expo-speech";
import {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionModule,
  ExpoSpeechRecognitionResultEvent,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform } from "react-native";
import appConfig from "../config.json";
import { useConversationHistory } from "./context/ConversationContext";
import type { SelectionOption } from "./shared.logic";

const DEFAULT_LOCALE = "en-US";
const UNSUPPORTED_PLATFORM = Platform.OS === "web";
const API_URL = getBackendUrl();
const WAVE_BAR_COUNT = 18;
const WAVE_MIN_SCALE = 0.12;
const WAVE_MAX_SCALE = 1.05;

type ChatMode = "workflow" | "main";
const CHAT_MODE: ChatMode =
  (appConfig as { mobile?: { chatMode?: string } }).mobile?.chatMode === "main"
    ? "main"
    : "workflow";

export type Status =
  | "checking"
  | "ready"
  | "listening"
  | "processing"
  | "speaking"
  | "error";

type Attachment = {
  uri: string;
  name: string;
  type: string;
};

type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

const EMPTY_TOKEN_USAGE: TokenUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

export function useMiniTalkieLogic() {
  const isFocused = useIsFocused();
  const { addAssistantMessage, addUserMessage } = useConversationHistory();
  const [status, setStatus] = useState<Status>(
    UNSUPPORTED_PLATFORM ? "error" : "checking"
  );
  const [transcript, setTranscript] = useState("");
  const [assistantReply, setAssistantReply] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [availableVoices, setAvailableVoices] = useState<Voice[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState(DEFAULT_LOCALE);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [activeSelector, setActiveSelector] = useState<
    "language" | "voice" | null
  >(null);
  const [sessionId, setSessionId] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>(EMPTY_TOKEN_USAGE);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [collectedDataText, setCollectedDataText] = useState("");

  const finalTranscriptRef = useRef("");
  const shouldSpeakOnEndRef = useRef(false);
  const sessionIdRef = useRef("");
  const attachmentsRef = useRef<Attachment[]>([]);
  const speechQueueRef = useRef<string[]>([]);
  const speechBufferRef = useRef("");
  const isSpeakingChunkRef = useRef(false);
  const streamCompleteRef = useRef(false);
  const activeRequestAbortRef = useRef<AbortController | null>(null);
  const continuousConversationRef = useRef(false);
  const manualStopRef = useRef(false);
  const statusRef = useRef<Status>(UNSUPPORTED_PLATFORM ? "error" : "checking");
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBargeInProgressRef = useRef(false);
  const latestTranscriptRef = useRef("");
  const aecAvailableRef = useRef(false);
  const lastNetworkRestartRef = useRef(0);
  const requestStartRef = useRef<number | null>(null);
  const firstChunkSeenRef = useRef(false);
  const rawAssistantReplyRef = useRef("");
  const lastSpokenMainLengthRef = useRef(0);
  const barScales = useRef(
    Array.from({ length: WAVE_BAR_COUNT }, () => new Animated.Value(0.2))
  ).current;
  const meterLevelRef = useRef(0);
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (assistantReply) {
      fadeAnim.setValue(0.8);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }).start();
    }
  }, [assistantReply, fadeAnim]);

  const resetSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }
    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null;
      if (statusRef.current === "processing") {
        return;
      }
      const text =
        finalTranscriptRef.current.trim() || latestTranscriptRef.current.trim();
      if (text && statusRef.current !== "error") {
        finalTranscriptRef.current = text;
        setTranscript(text);
        shouldSpeakOnEndRef.current = false;
        setStatus("processing");
        void fetchAssistantReply();
      }
    }, 2000);
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  useSpeechRecognitionEvent("start", () => {
    setErrorMessage("");
    setStatus("listening");
  });

  useSpeechRecognitionEvent(
    "result",
    (event: ExpoSpeechRecognitionResultEvent) => {
      const currentStatus = statusRef.current;
      if (currentStatus !== "listening" && currentStatus !== "error") {
        statusRef.current = "listening";
        setStatus("listening");
      }
      const nextTranscript = event.results[0]?.transcript?.trim() ?? "";

      if (!nextTranscript) {
        resetSilenceTimer();
        return;
      }

      latestTranscriptRef.current = nextTranscript;

      if (event.isFinal) {
        const separator = finalTranscriptRef.current ? " " : "";
        finalTranscriptRef.current += separator + nextTranscript;
        setTranscript(finalTranscriptRef.current);
        setPartialTranscript("");
      } else {
        setPartialTranscript(nextTranscript);
      }

      if (currentStatus === "speaking" || currentStatus === "processing") {
        finalTranscriptRef.current = "";
        isBargeInProgressRef.current = true;
        sendAbortSignal();
        activeRequestAbortRef.current?.abort();
        activeRequestAbortRef.current = null;
        if (currentStatus === "speaking") {
          Speech.stop().catch(() => undefined);
        }
        resetSpeechQueue();
        setAssistantReply("");
        statusRef.current = "listening";
        setStatus("listening");
      }

      resetSilenceTimer();
    }
  );

  useSpeechRecognitionEvent(
    "error",
    (event: ExpoSpeechRecognitionErrorEvent) => {
      clearSilenceTimer();
      const errorCode = `${event.error || ""}`.toLowerCase();
      const message = `${event.message || ""}`.toLowerCase();
      const isNetworkError =
        errorCode.includes("network") ||
        errorCode.includes("service-unavailable") ||
        message.includes("network") ||
        message.includes("service") ||
        message.includes("unavailable");

      if (isNetworkError && !manualStopRef.current) {
        const now = Date.now();
        if (now - lastNetworkRestartRef.current > 1500) {
          lastNetworkRestartRef.current = now;
          setErrorMessage("");
          setStatus("checking");
          setTimeout(() => {
            void beginListeningTurn({
              automatic: true,
              preserveAssistantReply: true,
            });
          }, 400);
        }
        return;
      }

      continuousConversationRef.current = false;
      setStatus("error");
      setErrorMessage(formatRecognitionError(event));
    }
  );

  useSpeechRecognitionEvent("end", () => {
    clearSilenceTimer();
  });

  useEffect(() => {
    if (UNSUPPORTED_PLATFORM) {
      setErrorMessage(
        "This app uses native speech APIs and needs an Android or iOS development build."
      );
      return;
    }

    void prepareRecognizer();
    void prepareVoices();

    return () => {
      activeRequestAbortRef.current?.abort();
      Speech.stop().catch(() => undefined);
      ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  useEffect(() => {
    if (!isFocused) {
      manualStopRef.current = true;
      clearSilenceTimer();
      ExpoSpeechRecognitionModule.abort();
      setStatus("ready");
      return;
    }

    if (UNSUPPORTED_PLATFORM || isMicMuted) {
      return;
    }

    manualStopRef.current = false;
    if (statusRef.current === "ready" || statusRef.current === "checking") {
      void beginListeningTurn({ automatic: true, preserveAssistantReply: true });
    }
  }, [beginListeningTurn, clearSilenceTimer, isFocused, isMicMuted]);

  const voicesForLanguage = useMemo(
    () => availableVoices.filter((voice) => voice.language === selectedLanguage),
    [availableVoices, selectedLanguage]
  );
  const languageOptions = useMemo(
    () => getLanguageOptions(availableVoices),
    [availableVoices]
  );
  const selectedVoice = useMemo(
    () =>
      voicesForLanguage.find((voice) => voice.identifier === selectedVoiceId) ??
      null,
    [selectedVoiceId, voicesForLanguage]
  );

  const prepareRecognizer = useCallback(async () => {
    try {
      const permissions =
        await ExpoSpeechRecognitionModule.getPermissionsAsync();

      if (!permissions.granted && !permissions.canAskAgain) {
        setStatus("error");
        setErrorMessage(
          "Microphone or speech permissions are blocked. Re-enable them in the device settings."
        );
        return;
      }

      const isAvailable = ExpoSpeechRecognitionModule.isRecognitionAvailable();
      if (!isAvailable) {
        setStatus("error");
        setErrorMessage(getUnavailableMessage());
        return;
      }

      if (typeof (ExpoSpeechRecognitionModule as any).isAecAvailable === "function") {
        aecAvailableRef.current = (ExpoSpeechRecognitionModule as any).isAecAvailable();
      }
      continuousConversationRef.current = true;
      manualStopRef.current = false;
      ExpoSpeechRecognitionModule.abort();
      await beginListeningTurn();
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        getErrorMessage(error, "Unable to initialize the speech recognizer.")
      );
    }
  }, []);

  const prepareVoices = useCallback(async () => {
    try {
      const voices = sortVoices(await Speech.getAvailableVoicesAsync());
      setAvailableVoices(voices);

      if (voices.length === 0) {
        setSelectedLanguage(DEFAULT_LOCALE);
        setSelectedVoiceId("");
        return;
      }

      const nextLanguage = pickInitialLanguage(voices, DEFAULT_LOCALE);
      const nextVoice = pickVoiceForLanguage(voices, nextLanguage);

      setSelectedLanguage(nextLanguage);
      setSelectedVoiceId(nextVoice?.identifier ?? "");
    } catch {
      setAvailableVoices([]);
      setSelectedVoiceId("");
    }
  }, []);

  const beginListeningTurn = useCallback(
    async ({
      automatic = false,
      preserveAssistantReply = false,
    }: {
      automatic?: boolean;
      preserveAssistantReply?: boolean;
    } = {}) => {
      try {
        ExpoSpeechRecognitionModule.abort();
        setStatus("checking");
        setErrorMessage("");
        setTranscript("");
        setPartialTranscript("");
        finalTranscriptRef.current = "";
        shouldSpeakOnEndRef.current = false;
        manualStopRef.current = false;

        if (!preserveAssistantReply) {
          setAssistantReply("");
        }

        if (!automatic) {
          await cancelActiveAssistantOutput();
        }

        const permissions =
          await ExpoSpeechRecognitionModule.requestPermissionsAsync();

        if (!permissions.granted) {
          continuousConversationRef.current = false;
          setStatus("error");
          setErrorMessage("Microphone permission was denied.");
          return;
        }

        if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
          continuousConversationRef.current = false;
          setStatus("error");
          setErrorMessage(getUnavailableMessage());
          return;
        }

        shouldSpeakOnEndRef.current = true;

        ExpoSpeechRecognitionModule.start({
          lang: selectedLanguage,
          interimResults: true,
          continuous: true,
          maxAlternatives: 1,
          androidIntentOptions: {
            EXTRA_LANGUAGE_MODEL: "free_form",
            EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 10000,
          },
        });
      } catch (error) {
        shouldSpeakOnEndRef.current = false;
        if (!automatic) {
          continuousConversationRef.current = false;
        }
        setStatus("error");
        setErrorMessage(getErrorMessage(error, "Unable to start listening."));
      }
    },
    [selectedLanguage]
  );

  const resumeListeningAfterSpeech = useCallback(async () => {
    if (
      !continuousConversationRef.current ||
      manualStopRef.current ||
      isMicMuted
    ) {
      return;
    }
    finalTranscriptRef.current = "";
    shouldSpeakOnEndRef.current = true;

    if (!aecAvailableRef.current) {
      ExpoSpeechRecognitionModule.start({
        lang: selectedLanguage,
        interimResults: true,
        continuous: true,
        maxAlternatives: 1,
        androidIntentOptions: {
          EXTRA_LANGUAGE_MODEL: "free_form",
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 10000,
        },
      });
    }

    setStatus("listening");
  }, [isMicMuted, selectedLanguage]);

  const fetchAssistantReply = useCallback(async () => {
    const spokenText = finalTranscriptRef.current.trim();
    const currentAttachments = attachmentsRef.current;

    if (!spokenText) {
      setPartialTranscript("");
      return;
    }
    finalTranscriptRef.current = "";

    const abortController = new AbortController();
    try {
      activeRequestAbortRef.current = abortController;
      resetSpeechQueue();
      setAssistantReply("");
      setCollectedDataText("");
      streamCompleteRef.current = false;
      requestStartRef.current = Date.now();
      firstChunkSeenRef.current = false;
      setLatencyMs(null);
      addUserMessage(
        spokenText,
        currentAttachments.length
          ? currentAttachments.map((attachment) => ({
              name: attachment.name,
              uri: attachment.uri,
              type: attachment.type,
            }))
          : undefined
      );

      if (CHAT_MODE === "main") {
        const {
          assistantReply: assistantText,
          sessionId: nextSessionId,
          tokenUsage: nextTokenUsage,
        } = await requestAssistantReplyMain(
          spokenText,
          sessionIdRef.current,
          currentAttachments
        );

        activeRequestAbortRef.current = null;
        streamCompleteRef.current = true;
        if (nextSessionId) {
          setSessionId(nextSessionId);
        }
        setTokenUsage(nextTokenUsage);
        setAttachments([]);
        const { mainText, collectedData } = splitCollectedData(assistantText);
        setAssistantReply(mainText);
        setCollectedDataText(collectedData);
        if (requestStartRef.current) {
          setLatencyMs(Date.now() - requestStartRef.current);
        }
        addAssistantMessage(mainText);
        queueSpeechText(mainText, true);
        if (!isSpeakingChunkRef.current && speechQueueRef.current.length === 0) {
          if (continuousConversationRef.current && !manualStopRef.current) {
            await resumeListeningAfterSpeech();
          }
        }
        return;
      }

      let streamedReply = "";
      rawAssistantReplyRef.current = "";
      lastSpokenMainLengthRef.current = 0;

      const onMetaHandler = (payload: WorkflowStreamPayload) => {
        const nextSessionIdFromMeta = `${
          payload.workflow_session_id || payload.session_id || ""
        }`.trim();
        if (nextSessionIdFromMeta) {
          setSessionId(nextSessionIdFromMeta);
        }
      };

      const onDeltaHandler = (delta: string) => {
        streamedReply += delta;
        rawAssistantReplyRef.current += delta;
        const parsed = splitCollectedData(rawAssistantReplyRef.current);
        setAssistantReply(parsed.mainText);
        setCollectedDataText(parsed.collectedData);
        if (!firstChunkSeenRef.current && requestStartRef.current) {
          firstChunkSeenRef.current = true;
          setLatencyMs(Date.now() - requestStartRef.current);
        }
        if (statusRef.current === "processing") {
          setStatus("speaking");
        }
        const nextSpeechText = getSafeSpeechDelta(
          parsed.mainText,
          lastSpokenMainLengthRef.current,
          parsed.hasMarker
        );
        if (nextSpeechText) {
          lastSpokenMainLengthRef.current =
            lastSpokenMainLengthRef.current + nextSpeechText.length;
          queueSpeechText(nextSpeechText);
        }
      };

      const onFinalHandler = (payload: WorkflowStreamPayload) => {
        streamCompleteRef.current = true;
        const finalReply = `${payload.response || streamedReply}`.trim();
        rawAssistantReplyRef.current = finalReply;
        const parsed = splitCollectedData(finalReply);
        setAssistantReply(parsed.mainText);
        setCollectedDataText(parsed.collectedData);
        if (!firstChunkSeenRef.current && requestStartRef.current) {
          firstChunkSeenRef.current = true;
          setLatencyMs(Date.now() - requestStartRef.current);
        }
        const remainingSpeech = parsed.mainText.slice(
          lastSpokenMainLengthRef.current
        );
        if (remainingSpeech) {
          lastSpokenMainLengthRef.current = parsed.mainText.length;
          queueSpeechText(remainingSpeech, true);
        } else {
          queueSpeechText("", true);
        }
      };

      const streamRequest = async () => {
        try {
          return await requestAssistantReplyStream(
            spokenText,
            sessionIdRef.current,
            currentAttachments,
            {
              signal: abortController.signal,
              onMeta: onMetaHandler,
              onDelta: onDeltaHandler,
              onFinal: onFinalHandler,
            }
          );
        } catch {
          return await requestAssistantReplyWebSocket(
            spokenText,
            sessionIdRef.current,
            currentAttachments,
            {
              signal: abortController.signal,
              onMeta: onMetaHandler,
              onDelta: onDeltaHandler,
              onFinal: onFinalHandler,
            }
          );
        }
      };

      const {
        assistantReply: assistantText,
        sessionId: nextSessionId,
        tokenUsage: nextTokenUsage,
      } = await streamRequest();

      activeRequestAbortRef.current = null;
      if (nextSessionId) {
        setSessionId(nextSessionId);
      }
      setTokenUsage(nextTokenUsage);
      setAttachments([]);
      const parsed = splitCollectedData(assistantText);
      setAssistantReply(parsed.mainText);
      setCollectedDataText(parsed.collectedData);
      addAssistantMessage(parsed.mainText);
      if (!isSpeakingChunkRef.current && speechQueueRef.current.length === 0) {
        if (continuousConversationRef.current && !manualStopRef.current) {
          await resumeListeningAfterSpeech();
        }
      }
    } catch (error) {
      activeRequestAbortRef.current = null;
      streamCompleteRef.current = true;
      if (abortController.signal.aborted) {
        return;
      }
      setLatencyMs(null);
      setStatus("error");
      setErrorMessage(
        getErrorMessage(error, "The app could not get a response from the assistant.")
      );
    }
  }, [addAssistantMessage, addUserMessage, attachments, resumeListeningAfterSpeech]);

  const handleResetConversation = useCallback(async () => {
    continuousConversationRef.current = false;
    manualStopRef.current = true;
    await cancelActiveAssistantOutput();
    await deleteConversationSession(sessionIdRef.current);
    setSessionId("");
    setTranscript("");
    setAssistantReply("");
    setPartialTranscript("");
    setAttachments([]);
    setTokenUsage(EMPTY_TOKEN_USAGE);
    setCollectedDataText("");
    finalTranscriptRef.current = "";
    shouldSpeakOnEndRef.current = false;

    if (status !== "checking") {
      setStatus(UNSUPPORTED_PLATFORM ? "error" : "ready");
    }
  }, [status]);

  const handleLanguageSelect = useCallback(
    (language: string) => {
      setSelectedLanguage(language);
      setSelectedVoiceId(
        pickVoiceForLanguage(availableVoices, language)?.identifier ?? ""
      );
      setActiveSelector(null);
    },
    [availableVoices]
  );

  const handleVoiceSelect = useCallback((voiceId: string) => {
    setSelectedVoiceId(voiceId);
    setActiveSelector(null);
  }, []);

  const handleTakePhoto = useCallback(async () => {
    try {
      setErrorMessage("");
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setStatus("error");
        setErrorMessage("Camera permission was denied.");
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: "images",
        quality: 1,
      });

      if (result.canceled || !result.assets[0]) {
        return;
      }

      const compressed = await compressImage(result.assets[0].uri);
      setAttachments((current) => [
        ...current,
        {
          uri: compressed.uri,
          name: `camera-${Date.now()}.jpg`,
          type: "image/jpeg",
        },
      ]);
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setErrorMessage(getErrorMessage(error, "Unable to capture a photo."));
    }
  }, []);

  const handlePickFiles = useCallback(async () => {
    try {
      setErrorMessage("");
      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/*", "application/pdf"],
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        return;
      }

      const nextAttachments = await Promise.all(
        result.assets.map(async (asset) => {
          const mimeType = asset.mimeType || guessMimeType(asset.name);
          if (mimeType.startsWith("image/")) {
            const compressed = await compressImage(asset.uri);
            return {
              uri: compressed.uri,
              name: asset.name || `image-${Date.now()}.jpg`,
              type: "image/jpeg",
            };
          }

          return {
            uri: asset.uri,
            name: asset.name || `document-${Date.now()}.pdf`,
            type: mimeType,
          };
        })
      );

      setAttachments((current) => [...current, ...nextAttachments]);
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setErrorMessage(getErrorMessage(error, "Unable to pick a file."));
    }
  }, []);

  const handleSendAttachments = useCallback(async () => {
    if (!attachments.length || uploadBusy) {
      return;
    }

    const abortController = new AbortController();
    try {
      setUploadBusy(true);
      setStatus("processing");
      setErrorMessage("");
      resetSpeechQueue();
      setAssistantReply("");
      setCollectedDataText("");
      activeRequestAbortRef.current = abortController;
      streamCompleteRef.current = false;

      if (CHAT_MODE === "main") {
        addUserMessage(
          "Please use the attached files to help with my current service request.",
          attachments.map((attachment) => ({
            name: attachment.name,
            uri: attachment.uri,
            type: attachment.type,
          }))
        );
        const {
          assistantReply: assistantText,
          sessionId: nextSessionId,
          tokenUsage: nextTokenUsage,
        } = await requestAssistantReplyMain(
          "Please use the attached files to help with my current service request.",
          sessionIdRef.current,
          attachments
        );

        activeRequestAbortRef.current = null;
        streamCompleteRef.current = true;
        if (nextSessionId) {
          setSessionId(nextSessionId);
        }
        setTokenUsage(nextTokenUsage);
        setAttachments([]);
        const parsed = splitCollectedData(assistantText);
        setAssistantReply(parsed.mainText);
        setCollectedDataText(parsed.collectedData);
        addAssistantMessage(parsed.mainText);
        queueSpeechText(parsed.mainText, true);
        if (!isSpeakingChunkRef.current && speechQueueRef.current.length === 0) {
          if (continuousConversationRef.current && !manualStopRef.current) {
            await resumeListeningAfterSpeech();
          }
        }
        return;
      }

      let streamedReply = "";
      rawAssistantReplyRef.current = "";
      lastSpokenMainLengthRef.current = 0;
      addUserMessage(
        "Please use the attached files to help with my current service request.",
        attachments.map((attachment) => ({
          name: attachment.name,
          uri: attachment.uri,
          type: attachment.type,
        }))
      );

      const sendOnMetaHandler = (payload: WorkflowStreamPayload) => {
        const nextSessionIdFromMeta = `${
          payload.workflow_session_id || payload.session_id || ""
        }`.trim();
        if (nextSessionIdFromMeta) {
          setSessionId(nextSessionIdFromMeta);
        }
      };

      const sendOnDeltaHandler = (delta: string) => {
        streamedReply += delta;
        rawAssistantReplyRef.current += delta;
        const parsed = splitCollectedData(rawAssistantReplyRef.current);
        setAssistantReply(parsed.mainText);
        setCollectedDataText(parsed.collectedData);
        if (statusRef.current === "processing") {
          setStatus("speaking");
        }
        const nextSpeechText = getSafeSpeechDelta(
          parsed.mainText,
          lastSpokenMainLengthRef.current,
          parsed.hasMarker
        );
        if (nextSpeechText) {
          lastSpokenMainLengthRef.current =
            lastSpokenMainLengthRef.current + nextSpeechText.length;
          queueSpeechText(nextSpeechText);
        }
      };

      const sendOnFinalHandler = (payload: WorkflowStreamPayload) => {
        streamCompleteRef.current = true;
        const finalReply = `${payload.response || streamedReply}`.trim();
        rawAssistantReplyRef.current = finalReply;
        const parsed = splitCollectedData(finalReply);
        setAssistantReply(parsed.mainText);
        setCollectedDataText(parsed.collectedData);
        const remainingSpeech = parsed.mainText.slice(
          lastSpokenMainLengthRef.current
        );
        if (remainingSpeech) {
          lastSpokenMainLengthRef.current = parsed.mainText.length;
          queueSpeechText(remainingSpeech, true);
        } else {
          queueSpeechText("", true);
        }
      };

      const streamRequest = async () => {
        try {
          return await requestAssistantReplyWebSocket(
            "Please use the attached files to help with my current service request.",
            sessionIdRef.current,
            attachments,
            {
              signal: abortController.signal,
              onMeta: sendOnMetaHandler,
              onDelta: sendOnDeltaHandler,
              onFinal: sendOnFinalHandler,
            }
          );
        } catch {
          return requestAssistantReplyStream(
            "Please use the attached files to help with my current service request.",
            sessionIdRef.current,
            attachments,
            {
              signal: abortController.signal,
              onMeta: sendOnMetaHandler,
              onDelta: sendOnDeltaHandler,
              onFinal: sendOnFinalHandler,
            }
          );
        }
      };

      const {
        assistantReply: assistantText,
        sessionId: nextSessionId,
        tokenUsage: nextTokenUsage,
      } = await streamRequest();

      activeRequestAbortRef.current = null;
      if (nextSessionId) {
        setSessionId(nextSessionId);
      }
      setTokenUsage(nextTokenUsage);
      setAttachments([]);
      const parsed = splitCollectedData(assistantText);
      setAssistantReply(parsed.mainText);
      setCollectedDataText(parsed.collectedData);
      addAssistantMessage(parsed.mainText);
      if (!isSpeakingChunkRef.current && speechQueueRef.current.length === 0) {
        if (continuousConversationRef.current && !manualStopRef.current) {
          await resumeListeningAfterSpeech();
        }
      }
    } catch (error) {
      activeRequestAbortRef.current = null;
      streamCompleteRef.current = true;
      if (abortController.signal.aborted) {
        return;
      }
      setStatus("error");
      setErrorMessage(getErrorMessage(error, "The app could not upload the file."));
    } finally {
      setUploadBusy(false);
    }
  }, [addAssistantMessage, addUserMessage, attachments, resumeListeningAfterSpeech, uploadBusy]);

  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const resetSpeechQueue = useCallback(() => {
    speechQueueRef.current = [];
    speechBufferRef.current = "";
    isSpeakingChunkRef.current = false;
    streamCompleteRef.current = false;
  }, []);

  const drainSpeechQueue = useCallback(() => {
    if (isSpeakingChunkRef.current) {
      return;
    }

    let nextChunk = "";
    while (speechQueueRef.current.length > 0 && !nextChunk) {
      nextChunk = prepareSpeechChunk(
        speechQueueRef.current.shift()?.trim() || ""
      );
    }

    if (!nextChunk) {
      if (streamCompleteRef.current && statusRef.current !== "error") {
        void resumeListeningAfterSpeech();
      }
      return;
    }

    isSpeakingChunkRef.current = true;

    if (!aecAvailableRef.current) {
      ExpoSpeechRecognitionModule.abort();
      clearSilenceTimer();
    }

    setStatus("speaking");

    Speech.speak(nextChunk, {
      language: selectedLanguage,
      voice: selectedVoiceId || undefined,
      onDone: () => {
        isSpeakingChunkRef.current = false;
        setTimeout(() => {
          drainSpeechQueue();
        }, 0);
      },
      onStopped: () => {
        isSpeakingChunkRef.current = false;
        if (isBargeInProgressRef.current) {
          isBargeInProgressRef.current = false;
          return;
        }
        if (speechQueueRef.current.length > 0) {
          setTimeout(() => {
            drainSpeechQueue();
          }, 0);
          return;
        }
        if (streamCompleteRef.current && statusRef.current !== "error") {
          if (manualStopRef.current || !continuousConversationRef.current) {
            return;
          }
          void resumeListeningAfterSpeech();
        }
      },
      onError: () => {
        isSpeakingChunkRef.current = false;
        setStatus("error");
        setErrorMessage("The device voice could not play back the assistant response.");
      },
    });
  }, [clearSilenceTimer, resumeListeningAfterSpeech, selectedLanguage, selectedVoiceId]);

  const queueSpeechText = useCallback(
    (text: string, force = false) => {
      const nextText = sanitizeTextForSpeech(text);
      if (!nextText) {
        if (force) {
          const { speakableChunks, remaining } = splitSpeakableChunks(
            speechBufferRef.current,
            true
          );
          speechBufferRef.current = remaining;
          if (speakableChunks.length) {
            speechQueueRef.current.push(...speakableChunks);
            drainSpeechQueue();
          }
        }
        return;
      }

      speechBufferRef.current += nextText;
      const { speakableChunks, remaining } = splitSpeakableChunks(
        speechBufferRef.current,
        force
      );
      speechBufferRef.current = remaining;

      if (speakableChunks.length) {
        speechQueueRef.current.push(...speakableChunks);
        drainSpeechQueue();
      }
    },
    [drainSpeechQueue]
  );

  const sendAbortSignal = useCallback(() => {
    const currentSessionId = sessionIdRef.current.trim();
    if (!currentSessionId) {
      return;
    }
    if (CHAT_MODE !== "workflow") {
      return;
    }
    fetch(`${API_URL}/workflows/chat/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_session_id: currentSessionId }),
    }).catch(() => undefined);
  }, []);

  const cancelActiveAssistantOutput = useCallback(async () => {
    activeRequestAbortRef.current?.abort();
    activeRequestAbortRef.current = null;
    clearSilenceTimer();
    isBargeInProgressRef.current = false;
    resetSpeechQueue();
    await Speech.stop().catch(() => undefined);
  }, [clearSilenceTimer, resetSpeechQueue]);

  useEffect(() => {
    const startMetering = async () => {
      if (recordingRef.current) {
        return;
      }
      try {
        const permissions = await Audio.requestPermissionsAsync();
        if (!permissions.granted) {
          return;
        }
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });
        const recording = new Audio.Recording();
        recording.setOnRecordingStatusUpdate(
          (statusUpdate: Audio.RecordingStatus) => {
            if (
              typeof statusUpdate.metering === "number" &&
              Number.isFinite(statusUpdate.metering)
            ) {
              const normalized = (statusUpdate.metering + 60) / 60;
              meterLevelRef.current = clamp(normalized, 0, 1);
            }
          }
        );
        recording.setProgressUpdateInterval(120);
        await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.LOW_QUALITY);
        await recording.startAsync();
        recordingRef.current = recording;
      } catch {
        if (recordingRef.current) {
          try {
            await recordingRef.current.stopAndUnloadAsync();
          } catch {
            // ignore
          }
          recordingRef.current = null;
        }
      }
    };

    const stopMetering = async () => {
      if (!recordingRef.current) {
        return;
      }
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch {
        // ignore
      }
      recordingRef.current = null;
    };

    if (status === "listening") {
      void startMetering();
    } else {
      void stopMetering();
    }
  }, [status]);

  useEffect(() => {
    if (meterTimerRef.current) {
      return () => undefined;
    }

    meterTimerRef.current = setInterval(() => {
      const currentStatus = statusRef.current;
      const baseLevel = getWaveBaseLevel(currentStatus, meterLevelRef.current);
      const timestamp = Date.now() / 140;
      barScales.forEach((bar, index) => {
        const phase = Math.sin(timestamp + index * 0.6) * 0.25 + 0.75;
        const jitter = 0.75 + Math.random() * 0.35;
        const next = clamp(
          baseLevel * phase * jitter,
          WAVE_MIN_SCALE,
          WAVE_MAX_SCALE
        );
        bar.setValue(next);
      });
    }, 120);

    return () => {
      if (meterTimerRef.current) {
        clearInterval(meterTimerRef.current);
        meterTimerRef.current = null;
      }
    };
  }, [barScales]);

  const liveText = partialTranscript || transcript;
  const displayReply = assistantReply.trim().length > 0;
  const panelLabel = displayReply ? "Assistant Replied" : "You Said";
  const panelText = displayReply
    ? assistantReply
    : liveText || "Your prompt will appear here while the app listens.";
  const voiceSelectorDisabled = voicesForLanguage.length === 0;
  const languageLabel = formatLanguageLabel(selectedLanguage);
  const voiceLabel = selectedVoice
    ? `${selectedVoice.name} (${selectedVoice.quality})`
    : "System default";
  const tokenUsageText = getTokenUsageLabel(tokenUsage);
  const latencyText = getLatencyLabel(latencyMs);
  const micToggleLabel = isMicMuted ? "Unmute Mic" : "Mute Mic";

  const languageOptionsForModal: SelectionOption[] = useMemo(
    () =>
      languageOptions.map((language) => ({
        key: language,
        label: formatLanguageLabel(language),
      })),
    [languageOptions]
  );
  const voiceOptionsForModal: SelectionOption[] = useMemo(
    () =>
      voicesForLanguage.map((voice) => ({
        key: voice.identifier,
        label: `${voice.name} (${voice.quality})`,
      })),
    [voicesForLanguage]
  );

  const openLanguageSelector = useCallback(() => {
    setActiveSelector("language");
  }, []);

  const openVoiceSelector = useCallback(() => {
    setActiveSelector("voice");
  }, []);

  const closeSelector = useCallback(() => {
    setActiveSelector(null);
  }, []);

  const retryListening = useCallback(() => {
    if (isMicMuted) {
      return;
    }
    void beginListeningTurn({ preserveAssistantReply: true });
  }, [beginListeningTurn, isMicMuted]);

  const toggleMicMute = useCallback(() => {
    const nextMuted = !isMicMuted;
    setIsMicMuted(nextMuted);

    if (nextMuted) {
      manualStopRef.current = true;
      clearSilenceTimer();
      ExpoSpeechRecognitionModule.abort();
      if (statusRef.current !== "error") {
        setStatus("ready");
      }
      return;
    }

    if (!UNSUPPORTED_PLATFORM && isFocused) {
      manualStopRef.current = false;
      void beginListeningTurn({ automatic: true, preserveAssistantReply: true });
    }
  }, [beginListeningTurn, clearSilenceTimer, isFocused, isMicMuted]);

  const sendAttachments = useCallback(() => {
    void handleSendAttachments();
  }, [handleSendAttachments]);

  const takePhoto = useCallback(() => {
    void handleTakePhoto();
  }, [handleTakePhoto]);

  const pickFiles = useCallback(() => {
    void handlePickFiles();
  }, [handlePickFiles]);

  const resetConversation = useCallback(() => {
    void handleResetConversation();
  }, [handleResetConversation]);

  const getRemoveAttachmentHandler = useCallback(
    (index: number) => () => handleRemoveAttachment(index),
    [handleRemoveAttachment]
  );

  return {
    activeSelector,
    attachments,
    barScales,
    collectedDataText,
    displayReply,
    errorMessage,
    fadeAnim,
    isMicMuted,
    languageLabel,
    languageOptions: languageOptionsForModal,
    latencyMs,
    latencyText,
    micToggleLabel,
    panelLabel,
    panelText,
    retryListening,
    resetConversation,
    openLanguageSelector,
    openVoiceSelector,
    closeSelector,
    handleLanguageSelect,
    handleVoiceSelect,
    pickFiles,
    sendAttachments,
    sessionId,
    status,
    takePhoto,
    tokenUsage,
    tokenUsageText,
    uploadBusy,
    voiceLabel,
    voiceOptions: voiceOptionsForModal,
    voiceSelectorDisabled,
    selectedLanguage,
    selectedVoiceId,
    getRemoveAttachmentHandler,
    toggleMicMute,
  };
}

const COLLECTED_DATA_MARKER = "COLLECTED_DATA:";
const MARKER_BUFFER_LENGTH = COLLECTED_DATA_MARKER.length;

function splitCollectedData(text: string) {
  const markerIndex = text.lastIndexOf(COLLECTED_DATA_MARKER);
  if (markerIndex < 0) {
    return {
      mainText: text.trim(),
      collectedData: "",
      hasMarker: false,
    };
  }

  const mainText = text.slice(0, markerIndex).trimEnd();
  const collectedData = text
    .slice(markerIndex + COLLECTED_DATA_MARKER.length)
    .trim();
  const normalized = collectedData.toLowerCase();
  const cleanedCollectedData =
    !collectedData || normalized === "none" || normalized === "none."
      ? ""
      : collectedData;
  return {
    mainText: mainText.trim(),
    collectedData: cleanedCollectedData,
    hasMarker: true,
  };
}

function getSafeSpeechDelta(
  mainText: string,
  lastSpokenLength: number,
  hasMarker: boolean
) {
  const safeLength = hasMarker
    ? mainText.length
    : Math.max(0, mainText.length - MARKER_BUFFER_LENGTH);
  if (safeLength <= lastSpokenLength) {
    return "";
  }
  return mainText.slice(lastSpokenLength, safeLength);
}

function formatRecognitionError(event: ExpoSpeechRecognitionErrorEvent) {
  if (event.error === "service-not-allowed") {
    return getUnavailableMessage();
  }

  if (event.error === "not-allowed") {
    return "Microphone or speech recognition permission was denied.";
  }

  if (event.error === "no-speech" || event.error === "speech-timeout") {
    return "I didn't catch that. Tap again and speak clearly.";
  }

  return `Speech recognition failed: ${event.message}`;
}

function getUnavailableMessage() {
  if (Platform.OS !== "android") {
    return "Speech recognition is not available on this device.";
  }

  const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices();
  const defaultService =
    ExpoSpeechRecognitionModule.getDefaultRecognitionService().packageName;

  if (services.length === 0) {
    return "No Android speech recognition service is installed. Use a physical device or a Google Play emulator image.";
  }

  if (!defaultService) {
    return `Speech recognition services exist (${services.join(", ")}) but none is configured as default. Set a default voice input service in Android settings.`;
  }

  return `Speech recognition is unavailable. Default service: ${defaultService}.`;
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

function sortVoices(voices: Voice[]) {
  return [...voices].sort((left, right) => {
    const languageCompare = left.language.localeCompare(right.language);
    if (languageCompare !== 0) {
      return languageCompare;
    }

    const qualityCompare = right.quality.localeCompare(left.quality);
    if (qualityCompare !== 0) {
      return qualityCompare;
    }

    return left.name.localeCompare(right.name);
  });
}

function getLanguageOptions(voices: Voice[]) {
  return [...new Set(voices.map((voice) => voice.language))];
}

function pickInitialLanguage(voices: Voice[], fallbackLanguage: string) {
  const languages = getLanguageOptions(voices);
  return languages.includes(fallbackLanguage)
    ? fallbackLanguage
    : languages[0] ?? fallbackLanguage;
}

function pickVoiceForLanguage(voices: Voice[], language: string) {
  return voices.find((voice) => voice.language === language) ?? null;
}

function formatLanguageLabel(language: string) {
  return language.replace(/_/g, "-");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getWaveBaseLevel(status: Status, meterLevel: number) {
  switch (status) {
    case "listening":
      return clamp(0.18 + meterLevel * 0.92, 0.18, 1.1);
    case "speaking":
      return 0.7;
    case "processing":
      return 0.45;
    case "ready":
      return 0.28;
    case "checking":
      return 0.22;
    case "error":
    default:
      return 0.15;
  }
}

function formatTokenUsage(tokenUsage: TokenUsage) {
  return `${tokenUsage.total_tokens} total (${tokenUsage.prompt_tokens} prompt / ${tokenUsage.completion_tokens} completion)`;
}

function formatLatency(latencyMs: number | null) {
  if (latencyMs === null) {
    return "--";
  }
  return `${latencyMs} ms`;
}

async function requestAssistantReply(
  prompt: string,
  sessionId?: string,
  attachments: Attachment[] = []
) {
  const requestPrompt = buildPrompt(prompt);
  const response = attachments.length
    ? await sendMultipartRequest(requestPrompt, sessionId, attachments)
    : await fetch(`${API_URL}/workflows/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: requestPrompt,
          workflow_session_id: sessionId || undefined,
        }),
      });

  const payload = (await response.json().catch(() => null)) as
    | {
        workflow_session_id?: string;
        session_id?: string;
        workflow_id?: string;
        workflow_title?: string;
        response?: string;
        detail?: string;
        token_usage?: Partial<TokenUsage>;
      }
    | null;

  if (!response.ok) {
    throw new Error(payload?.detail || "The backend returned an error.");
  }

  const assistantReply = payload?.response?.trim();
  if (!assistantReply) {
    throw new Error("The assistant returned an empty response.");
  }

  return {
    assistantReply,
    sessionId:
      payload?.workflow_session_id?.trim() || payload?.session_id?.trim() || "",
    tokenUsage: normalizeTokenUsage(payload?.token_usage),
  };
}

async function requestAssistantReplyMain(
  prompt: string,
  sessionId?: string,
  attachments: Attachment[] = []
) {
  const requestPrompt = buildPrompt(prompt);
  const response = attachments.length
    ? await sendMultipartRequestMain(requestPrompt, sessionId, attachments)
    : await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: requestPrompt,
          session_id: sessionId || undefined,
          reset: false,
        }),
      });

  const payload = (await response.json().catch(() => null)) as
    | {
        session_id?: string;
        response?: string;
        detail?: string;
        token_usage?: Partial<TokenUsage>;
      }
    | null;

  if (!response.ok) {
    throw new Error(payload?.detail || "The backend returned an error.");
  }

  const assistantReply = payload?.response?.trim();
  if (!assistantReply) {
    throw new Error("The assistant returned an empty response.");
  }

  return {
    assistantReply,
    sessionId: payload?.session_id?.trim() || "",
    tokenUsage: normalizeTokenUsage(payload?.token_usage),
  };
}

type WorkflowStreamPayload = {
  workflow_session_id?: string;
  session_id?: string;
  workflow_id?: string;
  workflow_title?: string;
  response?: string;
  text?: string;
  detail?: string;
  token_usage?: Partial<TokenUsage>;
};

type WorkflowStreamOptions = {
  signal?: AbortSignal;
  onMeta?: (payload: WorkflowStreamPayload) => void;
  onDelta?: (text: string) => void;
  onFinal?: (payload: WorkflowStreamPayload) => void;
};

async function requestAssistantReplyStream(
  prompt: string,
  sessionId?: string,
  attachments: Attachment[] = [],
  options: WorkflowStreamOptions = {}
) {
  const requestPrompt = buildPrompt(prompt);
  const response = attachments.length
    ? await sendMultipartStreamRequest(
        requestPrompt,
        sessionId,
        attachments,
        options.signal
      )
    : await fetch(`${API_URL}/workflows/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          prompt: requestPrompt,
          workflow_session_id: sessionId || undefined,
        }),
        signal: options.signal,
      });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | WorkflowStreamPayload
      | null;
    throw new Error(payload?.detail || "The backend returned an error.");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const fallback = await requestAssistantReply(prompt, sessionId, attachments);
    const fallbackPayload: WorkflowStreamPayload = {
      workflow_session_id: fallback.sessionId,
      response: fallback.assistantReply,
      token_usage: fallback.tokenUsage,
    };
    options.onMeta?.(fallbackPayload);
    options.onFinal?.(fallbackPayload);
    return fallback;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalPayload: WorkflowStreamPayload | null = null;
  let streamedReply = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let boundaryIndex = buffer.indexOf("\n\n");

    while (boundaryIndex >= 0) {
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      boundaryIndex = buffer.indexOf("\n\n");

      const parsedEvent = parseSseEvent(rawEvent);
      if (!parsedEvent) {
        continue;
      }

      if (parsedEvent.event === "meta") {
        options.onMeta?.(parsedEvent.data);
        continue;
      }

      if (parsedEvent.event === "delta") {
        const delta = `${parsedEvent.data?.text || ""}`;
        if (delta) {
          streamedReply += delta;
          options.onDelta?.(delta);
        }
        continue;
      }

      if (parsedEvent.event === "final") {
        finalPayload = parsedEvent.data;
        options.onFinal?.(parsedEvent.data);
        continue;
      }

      if (parsedEvent.event === "error") {
        throw new Error(parsedEvent.data?.detail || "The backend stream failed.");
      }
    }
  }

  if (!finalPayload) {
    throw new Error("The assistant stream ended without a final response.");
  }

  const assistantReply = `${finalPayload.response || streamedReply}`.trim();
  if (!assistantReply) {
    throw new Error("The assistant returned an empty response.");
  }

  return {
    assistantReply,
    sessionId: `${
      finalPayload.workflow_session_id || finalPayload.session_id || ""
    }`.trim(),
    tokenUsage: normalizeTokenUsage(finalPayload.token_usage),
  };
}

async function requestAssistantReplyWebSocket(
  prompt: string,
  sessionId?: string,
  attachments: Attachment[] = [],
  options: WorkflowStreamOptions = {}
) {
  if (attachments.length > 0) {
    return requestAssistantReplyStream(prompt, sessionId, attachments, options);
  }

  const wsUrl = `${getWebSocketUrl()}/workflows/chat/ws`;
  const ws = new WebSocket(wsUrl);
  let streamedReply = "";
  let finalPayload: WorkflowStreamPayload | null = null;

  return new Promise<{
    assistantReply: string;
    sessionId: string;
    tokenUsage: TokenUsage;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connection timed out."));
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timeout);
      ws.send(
        JSON.stringify({
          prompt: buildPrompt(prompt),
          workflow_session_id: sessionId || undefined,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg: Record<string, unknown> = JSON.parse(event.data);
        const msgEvent = String(msg.event || "");
        if (msgEvent === "meta") {
          options.onMeta?.(msg as unknown as WorkflowStreamPayload);
        } else if (msgEvent === "delta") {
          const delta = String(msg.text || "");
          if (delta) {
            streamedReply += delta;
            options.onDelta?.(delta);
          }
        } else if (msgEvent === "final") {
          finalPayload = msg as unknown as WorkflowStreamPayload;
          options.onFinal?.(finalPayload);
          clearTimeout(timeout);
          ws.close();
          const assistantReply = `${finalPayload.response || streamedReply}`.trim();
          if (!assistantReply) {
            reject(new Error("The assistant returned an empty response."));
          } else {
            resolve({
              assistantReply,
              sessionId: `${
                finalPayload.workflow_session_id || finalPayload.session_id || ""
              }`.trim(),
              tokenUsage: normalizeTokenUsage(finalPayload.token_usage),
            });
          }
        } else if (msgEvent === "error") {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(String(msg.detail || "WebSocket stream failed.")));
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection error."));
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      if (finalPayload) {
        return;
      }
      if (!streamedReply) {
        reject(new Error("WebSocket closed without a response."));
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        ws.close();
        reject(new Error("Request was aborted."));
      });
    }
  });
}

function normalizeTokenUsage(tokenUsage?: Partial<TokenUsage> | null): TokenUsage {
  return {
    prompt_tokens: Math.max(0, Number(tokenUsage?.prompt_tokens || 0)),
    completion_tokens: Math.max(0, Number(tokenUsage?.completion_tokens || 0)),
    total_tokens: Math.max(0, Number(tokenUsage?.total_tokens || 0)),
  };
}

function getTokenUsageLabel(tokenUsage: TokenUsage) {
  return formatTokenUsage(tokenUsage);
}

function getLatencyLabel(latencyMs: number | null) {
  return formatLatency(latencyMs);
}

async function sendMultipartRequest(
  prompt: string,
  sessionId: string | undefined,
  attachments: Attachment[]
) {
  const formData = new FormData();
  formData.append("prompt", prompt);

  if (sessionId?.trim()) {
    formData.append("workflow_session_id", sessionId.trim());
  }

  attachments.forEach((attachment) => {
    formData.append("file", {
      uri: attachment.uri,
      name: attachment.name,
      type: attachment.type,
    } as never);
  });

  return fetch(`${API_URL}/workflows/chat`, {
    method: "POST",
    body: formData,
  });
}

async function sendMultipartRequestMain(
  prompt: string,
  sessionId: string | undefined,
  attachments: Attachment[]
) {
  const formData = new FormData();
  formData.append("prompt", prompt);

  if (sessionId?.trim()) {
    formData.append("session_id", sessionId.trim());
  }

  attachments.forEach((attachment) => {
    formData.append("file", {
      uri: attachment.uri,
      name: attachment.name,
      type: attachment.type,
    } as never);
  });

  return fetch(`${API_URL}/chat`, {
    method: "POST",
    body: formData,
  });
}

async function sendMultipartStreamRequest(
  prompt: string,
  sessionId: string | undefined,
  attachments: Attachment[],
  signal?: AbortSignal
) {
  const formData = new FormData();
  formData.append("prompt", prompt);

  if (sessionId?.trim()) {
    formData.append("workflow_session_id", sessionId.trim());
  }

  attachments.forEach((attachment) => {
    formData.append("file", {
      uri: attachment.uri,
      name: attachment.name,
      type: attachment.type,
    } as never);
  });

  return fetch(`${API_URL}/workflows/chat/stream`, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
    },
    body: formData,
    signal,
  });
}

async function deleteConversationSession(sessionId: string) {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) {
    return;
  }

  try {
    const basePath = CHAT_MODE === "workflow" ? "workflows/sessions" : "sessions";
    await fetch(`${API_URL}/${basePath}/${encodeURIComponent(trimmedSessionId)}`, {
      method: "DELETE",
    });
  } catch {
    // Best-effort cleanup for an in-memory session.
  }
}

function buildPrompt(userPrompt: string) {
  return userPrompt.trim();
}

function parseSseEvent(rawEvent: string) {
  const trimmed = rawEvent.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  lines.forEach((line) => {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      return;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  });

  const dataText = dataLines.join("\n");
  if (!dataText) {
    return null;
  }

  try {
    return {
      event,
      data: JSON.parse(dataText) as WorkflowStreamPayload,
    };
  } catch {
    return null;
  }
}

function splitSpeakableChunks(text: string, force = false) {
  const normalized = text.replace(/\s+/g, " ");
  if (!normalized.trim()) {
    return { speakableChunks: [], remaining: "" };
  }

  const speakableChunks: string[] = [];
  let cursor = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    if (/[.!?]\s|[.!?]$/.test(normalized.slice(i, i + 2))) {
      const chunk = normalized.slice(cursor, i + 1).trim();
      if (chunk) {
        speakableChunks.push(chunk);
      }
      cursor = i + 1;
    }
  }

  let remaining = normalized.slice(cursor).trimStart();
  if (force && remaining.trim()) {
    speakableChunks.push(remaining.trim());
    remaining = "";
  } else if (!force && remaining.length >= 140) {
    const breakpoint = remaining.lastIndexOf(" ", 140);
    const chunk = remaining.slice(0, breakpoint > 0 ? breakpoint : 140).trim();
    if (chunk) {
      speakableChunks.push(chunk);
      remaining = remaining.slice(chunk.length).trimStart();
    }
  }

  return { speakableChunks, remaining };
}

function sanitizeTextForSpeech(text: string) {
  if (!text) {
    return "";
  }

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
    .replace(/~/g, "")
    .replace(/[|]/g, " ")
    .replace(/\s*:\s*/g, ", ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function prepareSpeechChunk(text: string) {
  if (!text) {
    return "";
  }

  return text
    .replace(/[.?!]+/g, " ")
    .replace(/[,;:]+/g, ", ")
    .replace(/[()[\]{}"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function compressImage(uri: string) {
  return ImageManipulator.manipulateAsync(uri, [], {
    compress: 0.6,
    format: ImageManipulator.SaveFormat.JPEG,
  });
}

function guessMimeType(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  return "image/jpeg";
}

function getBackendUrl() {
  const explicitUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (explicitUrl) {
    return explicitUrl.replace(/\/$/, "");
  }

  const configBackendUrl = appConfig.mobile?.backendUrl;

  if (Platform.OS === "android") {
    return (configBackendUrl?.android || configBackendUrl?.default || "").replace(
      /\/$/,
      ""
    );
  }

  if (Platform.OS === "ios") {
    return (configBackendUrl?.ios || configBackendUrl?.default || "").replace(
      /\/$/,
      ""
    );
  }

  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(":")[0];

  const defaultUrl = (configBackendUrl?.default || "").replace(/\/$/, "");

  return host ? defaultUrl : defaultUrl;
}

function getWebSocketUrl() {
  const httpUrl = getBackendUrl();
  return httpUrl.replace(/^https?:\/\//, (match) =>
    match === "https://" ? "wss://" : "ws://"
  );
}

