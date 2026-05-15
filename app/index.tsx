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
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import appConfig from "../config.json";

const DEFAULT_LOCALE = "en-US";
const UNSUPPORTED_PLATFORM = Platform.OS === "web";
const API_URL = getBackendUrl();
type ChatMode = "workflow" | "main";
const CHAT_MODE: ChatMode = appConfig.mobile?.chatMode === "main" ? "main" : "workflow";

type Status =
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

export default function MiniTalkie() {
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
  const [activeSelector, setActiveSelector] = useState<"language" | "voice" | null>(
    null
  );
  const [sessionId, setSessionId] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>(EMPTY_TOKEN_USAGE);

  const finalTranscriptRef = useRef("");
  const shouldSpeakOnEndRef = useRef(false);
  const sessionIdRef = useRef("");
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

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

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

  useSpeechRecognitionEvent("start", () => {
    setErrorMessage("");
    setStatus("listening");
  });

  const resetSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }
    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null;
      if (statusRef.current === "processing") {
        return;
      }
      const text = finalTranscriptRef.current.trim() || latestTranscriptRef.current.trim();
      if (text && statusRef.current !== "error") {
        finalTranscriptRef.current = text;
        setTranscript(text);
        shouldSpeakOnEndRef.current = false;
        setStatus("processing");
        void fetchAssistantReply();
      }
    }, 2000);
  };

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  useSpeechRecognitionEvent("result", (event: ExpoSpeechRecognitionResultEvent) => {
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

    if (statusRef.current === "speaking" || statusRef.current === "processing") {
      finalTranscriptRef.current = "";
      isBargeInProgressRef.current = true;
      sendAbortSignal();
      activeRequestAbortRef.current?.abort();
      activeRequestAbortRef.current = null;
      if (statusRef.current === "speaking") {
        Speech.stop().catch(() => undefined);
      }
      resetSpeechQueue();
      setAssistantReply("");
      statusRef.current = "listening";
      setStatus("listening");
    }

    resetSilenceTimer();
  });

  useSpeechRecognitionEvent("error", (event: ExpoSpeechRecognitionErrorEvent) => {
    continuousConversationRef.current = false;
    clearSilenceTimer();
    setStatus("error");
    setErrorMessage(formatRecognitionError(event));
  });

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

  const voicesForLanguage = availableVoices.filter(
    (voice) => voice.language === selectedLanguage
  );
  const languageOptions = getLanguageOptions(availableVoices);
  const selectedVoice =
    voicesForLanguage.find((voice) => voice.identifier === selectedVoiceId) ?? null;

  const prepareRecognizer = async () => {
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
  };

  const prepareVoices = async () => {
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
  };

  const beginListeningTurn = async ({
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
      setErrorMessage(
        getErrorMessage(error, "Unable to start listening.")
      );
    }
  };

  const resumeListeningAfterSpeech = async () => {
    if (!continuousConversationRef.current || manualStopRef.current) {
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
  };

  const fetchAssistantReply = async () => {
    const spokenText = finalTranscriptRef.current.trim();

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
      streamCompleteRef.current = false;

      if (CHAT_MODE === "main") {
        const {
          assistantReply: assistantText,
          sessionId: nextSessionId,
          tokenUsage: nextTokenUsage,
        } = await requestAssistantReplyMain(spokenText, sessionIdRef.current, attachments);

        activeRequestAbortRef.current = null;
        streamCompleteRef.current = true;
        if (nextSessionId) {
          setSessionId(nextSessionId);
        }
        setTokenUsage(nextTokenUsage);
        setAttachments([]);
        setAssistantReply(assistantText);
        queueSpeechText(assistantText, true);
        if (!isSpeakingChunkRef.current && speechQueueRef.current.length === 0) {
          if (continuousConversationRef.current && !manualStopRef.current) {
            await resumeListeningAfterSpeech();
          }
        }
        return;
      }

      let streamedReply = "";

      const streamRequest = async () => {
        try {
          return await requestAssistantReplyStream(spokenText, sessionIdRef.current, attachments, {
            signal: abortController.signal,
            onMeta: onMetaHandler,
            onDelta: onDeltaHandler,
            onFinal: onFinalHandler,
          });
        } catch {
          return await requestAssistantReplyWebSocket(spokenText, sessionIdRef.current, attachments, {
            signal: abortController.signal,
            onMeta: onMetaHandler,
            onDelta: onDeltaHandler,
            onFinal: onFinalHandler,
          });
        }
      };

      const onMetaHandler = (payload: WorkflowStreamPayload) => {
        const nextSessionIdFromMeta = `${payload.workflow_session_id || payload.session_id || ""}`.trim();
        if (nextSessionIdFromMeta) {
          setSessionId(nextSessionIdFromMeta);
        }
      };

      const onDeltaHandler = (delta: string) => {
        streamedReply += delta;
        setAssistantReply((current) => current + delta);
        if (statusRef.current === "processing") {
          setStatus("speaking");
        }
        queueSpeechText(delta);
      };

      const onFinalHandler = (payload: WorkflowStreamPayload) => {
        streamCompleteRef.current = true;
        const finalReply = `${payload.response || streamedReply}`.trim();
        const trailingText =
          finalReply.startsWith(streamedReply) && finalReply.length > streamedReply.length
            ? finalReply.slice(streamedReply.length)
            : "";

        if (trailingText) {
          streamedReply = finalReply;
          setAssistantReply((current) => current + trailingText);
          queueSpeechText(trailingText, true);
        } else {
          setAssistantReply(finalReply);
          queueSpeechText("", true);
        }
      };

      const { assistantReply: assistantText, sessionId: nextSessionId, tokenUsage: nextTokenUsage } =
        await streamRequest();

      activeRequestAbortRef.current = null;
      if (nextSessionId) {
        setSessionId(nextSessionId);
      }
      setTokenUsage(nextTokenUsage);
      setAttachments([]);
      setAssistantReply(assistantText);
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
      setErrorMessage(
        getErrorMessage(error, "The app could not get a response from the assistant.")
      );
    }
  };






  const handleResetConversation = async () => {
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
    finalTranscriptRef.current = "";
    shouldSpeakOnEndRef.current = false;

    if (status !== "checking") {
      setStatus(UNSUPPORTED_PLATFORM ? "error" : "ready");
    }
  };

  const handleLanguageSelect = (language: string) => {
    setSelectedLanguage(language);
    setSelectedVoiceId(pickVoiceForLanguage(availableVoices, language)?.identifier ?? "");
    setActiveSelector(null);
  };

  const handleVoiceSelect = (voiceId: string) => {
    setSelectedVoiceId(voiceId);
    setActiveSelector(null);
  };

  const handleTakePhoto = async () => {
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
  };

  const handlePickFiles = async () => {
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
  };

  const handleSendAttachments = async () => {
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
      activeRequestAbortRef.current = abortController;
      streamCompleteRef.current = false;

      if (CHAT_MODE === "main") {
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
        setAssistantReply(assistantText);
        queueSpeechText(assistantText, true);
        if (!isSpeakingChunkRef.current && speechQueueRef.current.length === 0) {
          if (continuousConversationRef.current && !manualStopRef.current) {
            await resumeListeningAfterSpeech();
          }
        }
        return;
      }

      let streamedReply = "";

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

      const sendOnMetaHandler = (payload: WorkflowStreamPayload) => {
        const nextSessionIdFromMeta = `${payload.workflow_session_id || payload.session_id || ""}`.trim();
        if (nextSessionIdFromMeta) {
          setSessionId(nextSessionIdFromMeta);
        }
      };

      const sendOnDeltaHandler = (delta: string) => {
        streamedReply += delta;
        setAssistantReply((current) => current + delta);
        if (statusRef.current === "processing") {
          setStatus("speaking");
        }
        queueSpeechText(delta);
      };

      const sendOnFinalHandler = (payload: WorkflowStreamPayload) => {
        streamCompleteRef.current = true;
        const finalReply = `${payload.response || streamedReply}`.trim();
        const trailingText =
          finalReply.startsWith(streamedReply) && finalReply.length > streamedReply.length
            ? finalReply.slice(streamedReply.length)
            : "";

        if (trailingText) {
          streamedReply = finalReply;
          setAssistantReply((current) => current + trailingText);
          queueSpeechText(trailingText, true);
        } else {
          setAssistantReply(finalReply);
          queueSpeechText("", true);
        }
      };

      const { assistantReply: assistantText, sessionId: nextSessionId, tokenUsage: nextTokenUsage } =
        await streamRequest();

      activeRequestAbortRef.current = null;
      if (nextSessionId) {
        setSessionId(nextSessionId);
      }
      setTokenUsage(nextTokenUsage);

      setAttachments([]);
      setAssistantReply(assistantText);
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
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

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

  const resetSpeechQueue = () => {
    speechQueueRef.current = [];
    speechBufferRef.current = "";
    isSpeakingChunkRef.current = false;
    streamCompleteRef.current = false;
  };

  const drainSpeechQueue = () => {
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
  };

  const queueSpeechText = (text: string, force = false) => {
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
  };

  const sendAbortSignal = () => {
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
  };

  const cancelActiveAssistantOutput = async () => {
    activeRequestAbortRef.current?.abort();
    activeRequestAbortRef.current = null;
    clearSilenceTimer();
    isBargeInProgressRef.current = false;
    resetSpeechQueue();
    await Speech.stop().catch(() => undefined);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.container}>
          <View style={styles.controlsCard}>
            <Text style={styles.sectionLabel}>Speech Settings</Text>
            <SelectorField
              label="Language"
              value={languageLabel}
              disabled={languageOptions.length === 0}
              onPress={() => setActiveSelector("language")}
            />
            <SelectorField
              label="Voice"
              value={voiceLabel}
              disabled={voiceSelectorDisabled}
              onPress={() => setActiveSelector("voice")}
            />
            <Pressable
              accessibilityRole="button"
              disabled={!sessionId}
              onPress={() => void handleResetConversation()}
              style={({ pressed }) => [
                styles.resetButton,
                !sessionId ? styles.resetButtonDisabled : null,
                pressed && sessionId ? styles.resetButtonPressed : null,
              ]}
            >
              <Text style={styles.resetButtonText}>End Conversation</Text>
            </Pressable>
            <View style={styles.metaPanel}>
              <Text style={styles.metaLabel}>Session</Text>
              <Text style={styles.metaValue}>
                {sessionId.trim() || "No active session"}
              </Text>
              <Text style={styles.metaLabel}>Tokens Used</Text>
              <Text style={styles.metaValue}>
                {formatTokenUsage(tokenUsage)}
              </Text>
            </View>
            <View style={styles.uploadActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => void handleTakePhoto()}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed ? styles.secondaryButtonPressed : null,
                ]}
              >
                <Text style={styles.secondaryButtonText}>Take Photo</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void handlePickFiles()}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed ? styles.secondaryButtonPressed : null,
                ]}
              >
                <Text style={styles.secondaryButtonText}>Upload File</Text>
              </Pressable>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={!attachments.length || uploadBusy}
              onPress={() => void handleSendAttachments()}
              style={({ pressed }) => [
                styles.uploadSendButton,
                !attachments.length || uploadBusy ? styles.resetButtonDisabled : null,
                pressed && attachments.length && !uploadBusy ? styles.resetButtonPressed : null,
              ]}
            >
              <Text style={styles.uploadSendButtonText}>
                {uploadBusy ? "Sending..." : "Send Attached Files"}
              </Text>
            </Pressable>
            {attachments.length ? (
              <View style={styles.attachmentList}>
                {attachments.map((attachment, index) => (
                  <Pressable
                    key={`${attachment.name}-${attachment.uri}`}
                    onPress={() => handleRemoveAttachment(index)}
                    style={({ pressed }) => [
                      styles.attachmentChip,
                      pressed ? styles.attachmentChipPressed : null,
                    ]}
                  >
                    <Text style={styles.attachmentChipText}>{attachment.name}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>

          <View style={styles.transcriptCard}>
            <Text style={styles.sectionLabel}>{panelLabel}</Text>
            <ScrollView
              style={styles.panelScroll}
              contentContainerStyle={styles.panelScrollContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator={displayReply}
            >
              {displayReply ? (
                <Animated.Text style={[styles.replyText, { opacity: fadeAnim }]}>
                  {panelText}
                </Animated.Text>
              ) : (
                <Text style={styles.transcriptText}>{panelText}</Text>
              )}
            </ScrollView>
          </View>

          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

          <View style={styles.stateContainer}>
            {status === "checking" || status === "processing" ? (
              <ActivityIndicator size="large" color="#0f3d91" />
            ) : null}
            <Text style={styles.stateMessage}>{getStatusMessage(status)}</Text>
          </View>
        </View>
      </ScrollView>

      <SelectionModal
        title="Choose language"
        visible={activeSelector === "language"}
        options={languageOptions.map((language) => ({
          key: language,
          label: formatLanguageLabel(language),
        }))}
        selectedKey={selectedLanguage}
        onClose={() => setActiveSelector(null)}
        onSelect={handleLanguageSelect}
      />

      <SelectionModal
        title="Choose voice"
        visible={activeSelector === "voice"}
        options={voicesForLanguage.map((voice) => ({
          key: voice.identifier,
          label: `${voice.name} (${voice.quality})`,
        }))}
        selectedKey={selectedVoiceId}
        onClose={() => setActiveSelector(null)}
        onSelect={handleVoiceSelect}
      />
    </SafeAreaView>
  );
}

type SelectorFieldProps = {
  label: string;
  value: string;
  disabled?: boolean;
  onPress: () => void;
};

function SelectorField({
  label,
  value,
  disabled = false,
  onPress,
}: SelectorFieldProps) {
  return (
    <View style={styles.selectorRow}>
      <Text style={styles.selectorLabel}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.selectorButton,
          disabled ? styles.selectorButtonDisabled : null,
          pressed && !disabled ? styles.selectorButtonPressed : null,
        ]}
      >
        <Text style={styles.selectorValue}>{value}</Text>
        <Text style={styles.selectorChevron}>Select</Text>
      </Pressable>
    </View>
  );
}

type SelectionModalProps = {
  title: string;
  visible: boolean;
  options: { key: string; label: string }[];
  selectedKey: string;
  onClose: () => void;
  onSelect: (key: string) => void;
};

function SelectionModal({
  title,
  visible,
  options,
  selectedKey,
  onClose,
  onSelect,
}: SelectionModalProps) {
  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.modalBackdrop}>
        <Pressable style={styles.modalDismissArea} onPress={onClose} />
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{title}</Text>
          <ScrollView style={styles.modalList} showsVerticalScrollIndicator={false}>
            {options.map((option) => {
              const selected = option.key === selectedKey;

              return (
                <Pressable
                  key={option.key}
                  onPress={() => onSelect(option.key)}
                  style={({ pressed }) => [
                    styles.modalOption,
                    selected ? styles.modalOptionSelected : null,
                    pressed ? styles.modalOptionPressed : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.modalOptionText,
                      selected ? styles.modalOptionTextSelected : null,
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable onPress={onClose} style={styles.modalCloseButton}>
            <Text style={styles.modalCloseText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
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
  return languages.includes(fallbackLanguage) ? fallbackLanguage : languages[0] ?? fallbackLanguage;
}

function pickVoiceForLanguage(voices: Voice[], language: string) {
  return voices.find((voice) => voice.language === language) ?? null;
}

function formatLanguageLabel(language: string) {
  return language.replace(/_/g, "-");
}

function getStatusMessage(status: Status) {
  switch (status) {
    case "checking":
      return "Initializing...";
    case "ready":
      return "Ready to listen";
    case "listening":
      return "Listening...";
    case "processing":
      return "Thinking...";
    case "speaking":
      return "Speaking";
    case "error":
      return "Something went wrong";
    default:
      return "";
  }
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
    sessionId: payload?.workflow_session_id?.trim() || payload?.session_id?.trim() || "",
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
    ? await sendMultipartStreamRequest(requestPrompt, sessionId, attachments, options.signal)
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
    const payload = (await response.json().catch(() => null)) as WorkflowStreamPayload | null;
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
    sessionId:
      `${finalPayload.workflow_session_id || finalPayload.session_id || ""}`.trim(),
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
              sessionId:
                `${finalPayload.workflow_session_id || finalPayload.session_id || ""}`.trim(),
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

function formatTokenUsage(tokenUsage: TokenUsage) {
  return `${tokenUsage.total_tokens} total (${tokenUsage.prompt_tokens} prompt / ${tokenUsage.completion_tokens} completion)`;
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
    return (configBackendUrl?.android || configBackendUrl?.default || "").replace(/\/$/, "");
  }

  if (Platform.OS === "ios") {
    return (configBackendUrl?.ios || configBackendUrl?.default || "").replace(/\/$/, "");
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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#eef3fb",
  },
  scrollContent: {
    flexGrow: 1,
  },
  container: {
    paddingHorizontal: 24,
    paddingVertical: 20,
    justifyContent: "center",
    gap: 16,
    backgroundColor: "#eef3fb",
    flexGrow: 1,
  },
  controlsCard: {
    padding: 18,
    borderRadius: 22,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#c7d4eb",
    gap: 12,
    shadowColor: "#0f3d91",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
  transcriptCard: {
    height: 220,
    padding: 18,
    borderRadius: 22,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#c7d4eb",
    shadowColor: "#0f3d91",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
  panelScroll: {
    flex: 1,
  },
  panelScrollContent: {
    paddingBottom: 4,
  },
  sectionLabel: {
    color: "#0f3d91",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  transcriptText: {
    color: "#10284c",
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "600",
  },
  replyText: {
    color: "#10284c",
    fontSize: 16,
    lineHeight: 23,
    fontWeight: "500",
  },
  errorText: {
    color: "#c9163a",
    fontSize: 14,
    lineHeight: 20,
  },
  selectorRow: {
    gap: 6,
  },
  selectorLabel: {
    color: "#1c3f78",
    fontSize: 13,
    fontWeight: "700",
  },
  selectorButton: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#b9cae6",
    backgroundColor: "#f7faff",
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  selectorButtonDisabled: {
    opacity: 0.55,
  },
  selectorButtonPressed: {
    transform: [{ scale: 0.99 }],
  },
  selectorValue: {
    flex: 1,
    color: "#10284c",
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
  },
  selectorChevron: {
    color: "#0f3d91",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  resetButton: {
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#b9cae6",
    backgroundColor: "#edf4ff",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  resetButtonDisabled: {
    opacity: 0.5,
  },
  resetButtonPressed: {
    transform: [{ scale: 0.99 }],
  },
  resetButtonText: {
    color: "#0f3d91",
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  metaPanel: {
    gap: 4,
    borderWidth: 1,
    borderColor: "#c7d4eb",
    borderRadius: 16,
    backgroundColor: "#f7faff",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  metaLabel: {
    color: "#58739a",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 2,
  },
  metaValue: {
    color: "#10284c",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  uploadActions: {
    flexDirection: "row",
    gap: 10,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#b9cae6",
    backgroundColor: "#f4f8ff",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  secondaryButtonPressed: {
    transform: [{ scale: 0.99 }],
  },
  secondaryButtonText: {
    color: "#0f3d91",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  uploadSendButton: {
    minHeight: 42,
    borderRadius: 14,
    backgroundColor: "#0f3d91",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  uploadSendButtonText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  attachmentList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  attachmentChip: {
    borderRadius: 999,
    backgroundColor: "#e3edfb",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  attachmentChipPressed: {
    opacity: 0.8,
  },
  attachmentChipText: {
    color: "#163867",
    fontSize: 12,
    fontWeight: "700",
  },
  stateContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    gap: 12,
  },
  stateMessage: {
    color: "#0f3d91",
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 28,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 32, 84, 0.35)",
    justifyContent: "flex-end",
  },
  modalDismissArea: {
    flex: 1,
  },
  modalCard: {
    maxHeight: "70%",
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
    gap: 14,
  },
  modalTitle: {
    color: "#0f3d91",
    fontSize: 18,
    fontWeight: "800",
  },
  modalList: {
    maxHeight: 320,
  },
  modalOption: {
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: "center",
  },
  modalOptionSelected: {
    backgroundColor: "#e7f0ff",
  },
  modalOptionPressed: {
    opacity: 0.8,
  },
  modalOptionText: {
    color: "#10284c",
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "500",
  },
  modalOptionTextSelected: {
    fontWeight: "800",
  },
  modalCloseButton: {
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: "#0f3d91",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCloseText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
  },
});
