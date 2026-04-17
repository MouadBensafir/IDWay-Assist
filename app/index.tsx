import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Constants from "expo-constants";
import * as Speech from "expo-speech";
import type { Voice } from "expo-speech";
import {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionModule,
  ExpoSpeechRecognitionResultEvent,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import appConfig from "../config.json";

const DEFAULT_LOCALE = "en-US";
const UNSUPPORTED_PLATFORM = Platform.OS === "web";
const API_URL = getBackendUrl();

type Status =
  | "checking"
  | "ready"
  | "listening"
  | "processing"
  | "speaking"
  | "error";

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

  const finalTranscriptRef = useRef("");
  const shouldSpeakOnEndRef = useRef(false);
  const sessionIdRef = useRef("");

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useSpeechRecognitionEvent("start", () => {
    setErrorMessage("");
    setStatus("listening");
  });

  useSpeechRecognitionEvent("result", (event: ExpoSpeechRecognitionResultEvent) => {
    const nextTranscript = event.results[0]?.transcript?.trim() ?? "";

    if (!nextTranscript) {
      return;
    }

    setPartialTranscript(nextTranscript);

    if (event.isFinal) {
      finalTranscriptRef.current = nextTranscript;
      setTranscript(nextTranscript);
    }
  });

  useSpeechRecognitionEvent("error", (event: ExpoSpeechRecognitionErrorEvent) => {
    shouldSpeakOnEndRef.current = false;
    setStatus("error");
    setErrorMessage(formatRecognitionError(event));
  });

  useSpeechRecognitionEvent("end", () => {
    void handleRecognitionEnded();
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
      void deleteConversationSession(sessionIdRef.current);
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

      setStatus("ready");
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

  const handleRecognitionEnded = async () => {
    if (!shouldSpeakOnEndRef.current) {
      if (status !== "error") {
        setStatus("ready");
      }
      return;
    }

    shouldSpeakOnEndRef.current = false;
    setStatus("processing");
    await fetchAssistantReply();
  };

  const fetchAssistantReply = async () => {
    const spokenText = finalTranscriptRef.current.trim();

    if (!spokenText) {
      setStatus("ready");
      setPartialTranscript("");
      setErrorMessage("No speech was captured. Tap and try again.");
      return;
    }

    try {
      const { assistantReply: qwenReply, sessionId: nextSessionId } =
        await requestAssistantReply(spokenText, sessionId);
      if (nextSessionId) {
        setSessionId(nextSessionId);
      }
      setAssistantReply(qwenReply);
      setStatus("speaking");
      await Speech.stop();

      Speech.speak(qwenReply, {
        language: selectedLanguage,
        voice: selectedVoiceId || undefined,
        onDone: () => setStatus("ready"),
        onStopped: () => setStatus("ready"),
        onError: () => {
          setStatus("error");
          setErrorMessage("The device voice could not play back Qwen's response.");
        },
      });
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        getErrorMessage(error, "The app could not get a response from Qwen.")
      );
    }
  };

  const handleListenPress = async () => {
    try {
      setStatus("checking");
      setErrorMessage("");
      setTranscript("");
      setAssistantReply("");
      setPartialTranscript("");
      finalTranscriptRef.current = "";
      shouldSpeakOnEndRef.current = false;

      await Speech.stop();

      const permissions =
        await ExpoSpeechRecognitionModule.requestPermissionsAsync();

      if (!permissions.granted) {
        setStatus("error");
        setErrorMessage("Microphone permission was denied.");
        return;
      }

      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        setStatus("error");
        setErrorMessage(getUnavailableMessage());
        return;
      }

      shouldSpeakOnEndRef.current = true;

      ExpoSpeechRecognitionModule.start({
        lang: selectedLanguage,
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
        androidIntentOptions: {
          EXTRA_LANGUAGE_MODEL: "free_form",
        },
      });
    } catch (error) {
      shouldSpeakOnEndRef.current = false;
      setStatus("error");
      setErrorMessage(
        getErrorMessage(error, "Unable to start listening.")
      );
    }
  };

  const handleMainButtonPress = async () => {
    if (status === "speaking") {
      try {
        await Speech.stop();
        setStatus("ready");
      } catch (error) {
        setStatus("error");
        setErrorMessage(
          getErrorMessage(error, "Unable to stop speaking.")
        );
      }
      return;
    }

    await handleListenPress();
  };

  const handleResetConversation = async () => {
    await deleteConversationSession(sessionId);
    setSessionId("");
    setTranscript("");
    setAssistantReply("");
    setPartialTranscript("");
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

  const liveText = partialTranscript || transcript;
  const buttonDisabled =
    UNSUPPORTED_PLATFORM ||
    status === "checking" ||
    status === "listening";
  const displayReply = assistantReply.trim().length > 0;
  const panelLabel = displayReply ? "Qwen Replied" : "You Said";
  const panelText = displayReply
    ? assistantReply
    : liveText || "Your prompt will appear here while the app listens.";
  const voiceSelectorDisabled = voicesForLanguage.length === 0;
  const languageLabel = formatLanguageLabel(selectedLanguage);
  const voiceLabel = selectedVoice
    ? `${selectedVoice.name} (${selectedVoice.quality})`
    : "System default";

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
          </View>

          <View style={styles.transcriptCard}>
            <Text style={styles.sectionLabel}>{panelLabel}</Text>
            <ScrollView
              style={styles.panelScroll}
              contentContainerStyle={styles.panelScrollContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator={displayReply}
            >
              <Text style={displayReply ? styles.replyText : styles.transcriptText}>
                {panelText}
              </Text>
            </ScrollView>
          </View>

          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

          <Pressable
            accessibilityRole="button"
            disabled={buttonDisabled}
            onPress={() => void handleMainButtonPress()}
            style={({ pressed }) => [
              styles.button,
              buttonDisabled ? styles.buttonDisabled : null,
              pressed && !buttonDisabled ? styles.buttonPressed : null,
            ]}
          >
            {status === "checking" ? (
              <ActivityIndicator color="#f4efe6" />
            ) : (
              <Text style={styles.buttonText}>{getButtonLabel(status)}</Text>
            )}
          </Pressable>

          <Text style={styles.statusText}>{getStatusMessage(status)}</Text>
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

function getButtonLabel(status: Status) {
  if (status === "listening") {
    return "Listening...";
  }

  if (status === "speaking") {
    return "Stop Speaking";
  }

  return "Tap To Speak";
}

function getStatusMessage(status: Status) {
  switch (status) {
    case "checking":
      return "Preparing the recognizer.";
    case "ready":
      return "Ready for the next prompt.";
    case "listening":
      return "Listening until you stop speaking.";
    case "processing":
      return "Sending the prompt to Qwen.";
    case "speaking":
      return "Speaking Qwen's response.";
    case "error":
      return "The request could not be completed.";
    default:
      return "Waiting.";
  }
}

async function requestAssistantReply(prompt: string, sessionId?: string) {
  const requestPrompt = buildPrompt(prompt);
  const response = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: requestPrompt,
      session_id: sessionId || undefined,
    }),
  });

  const payload = (await response.json().catch(() => null)) as
    | { session_id?: string; response?: string; detail?: string }
    | null;

  if (!response.ok) {
    throw new Error(payload?.detail || "The backend returned an error.");
  }

  const assistantReply = payload?.response?.trim();
  if (!assistantReply) {
    throw new Error("Qwen returned an empty response.");
  }

  return {
    assistantReply,
    sessionId: payload?.session_id?.trim() || "",
  };
}

async function deleteConversationSession(sessionId: string) {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) {
    return;
  }

  try {
    await fetch(`${API_URL}/sessions/${encodeURIComponent(trimmedSessionId)}`, {
      method: "DELETE",
    });
  } catch {
    // Best-effort cleanup for an in-memory session.
  }
}

function buildPrompt(userPrompt: string) {
  const basePrompt = appConfig.mobile?.basePrompt?.trim();
  const cleanedUserPrompt = userPrompt.trim();

  if (!basePrompt) {
    return cleanedUserPrompt;
  }

  return `${basePrompt}\n\nUser prompt:\n${cleanedUserPrompt}`;
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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f4efe6",
  },
  scrollContent: {
    flexGrow: 1,
  },
  container: {
    paddingHorizontal: 24,
    paddingVertical: 20,
    justifyContent: "center",
    gap: 16,
    backgroundColor: "#f4efe6",
    flexGrow: 1,
  },
  controlsCard: {
    padding: 18,
    borderRadius: 22,
    backgroundColor: "#fffaf2",
    borderWidth: 1,
    borderColor: "#eadfcb",
    gap: 12,
  },
  transcriptCard: {
    height: 220,
    padding: 18,
    borderRadius: 22,
    backgroundColor: "#fffaf2",
    borderWidth: 1,
    borderColor: "#eadfcb",
  },
  panelScroll: {
    flex: 1,
  },
  panelScrollContent: {
    paddingBottom: 4,
  },
  sectionLabel: {
    color: "#7a6c58",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  transcriptText: {
    color: "#1d1d1d",
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "600",
  },
  replyText: {
    color: "#1d1d1d",
    fontSize: 16,
    lineHeight: 23,
    fontWeight: "500",
  },
  errorText: {
    color: "#b42318",
    fontSize: 14,
    lineHeight: 20,
  },
  selectorRow: {
    gap: 6,
  },
  selectorLabel: {
    color: "#5b5449",
    fontSize: 13,
    fontWeight: "700",
  },
  selectorButton: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#e3d5c2",
    backgroundColor: "#fef8ef",
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
    color: "#1d1d1d",
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
  },
  selectorChevron: {
    color: "#8c7356",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  resetButton: {
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e3d5c2",
    backgroundColor: "#f8efe3",
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
    color: "#6f5d45",
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  button: {
    minHeight: 54,
    borderRadius: 999,
    backgroundColor: "#c84c31",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonPressed: {
    transform: [{ scale: 0.98 }],
  },
  buttonText: {
    color: "#fef6eb",
    fontSize: 15,
    fontWeight: "800",
  },
  statusText: {
    color: "#5b5449",
    textAlign: "center",
    fontSize: 13,
    lineHeight: 18,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(29, 29, 29, 0.35)",
    justifyContent: "flex-end",
  },
  modalDismissArea: {
    flex: 1,
  },
  modalCard: {
    maxHeight: "70%",
    backgroundColor: "#fffaf2",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
    gap: 14,
  },
  modalTitle: {
    color: "#1d1d1d",
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
    backgroundColor: "#f0e0ca",
  },
  modalOptionPressed: {
    opacity: 0.8,
  },
  modalOptionText: {
    color: "#1d1d1d",
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
    backgroundColor: "#c84c31",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCloseText: {
    color: "#fef6eb",
    fontSize: 14,
    fontWeight: "800",
  },
});
