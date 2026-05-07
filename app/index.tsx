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
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
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

type FormState = {
  fullName: string;
  dateOfBirth: string;
  phone: string;
  email: string;
  nationality: string;
  idNumber: string;
  addressLine1: string;
  city: string;
  serviceType: string;
  preferredCenter: string;
  appointmentDate: string;
  appointmentTime: string;
  notes: string;
};

type FormFillPayload = Partial<Record<keyof FormState, string | null>> & {
  complete?: boolean;
};

const EMPTY_TOKEN_USAGE: TokenUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

const FORM_FIELD_CONFIG: Array<{
  key: keyof FormState;
  label: string;
  placeholder: string;
  multiline?: boolean;
}> = [
  { key: "fullName", label: "Full Name", placeholder: "Jane Maria Doe" },
  { key: "dateOfBirth", label: "Date of Birth", placeholder: "YYYY-MM-DD" },
  { key: "phone", label: "Phone", placeholder: "+1 555 123 4567" },
  { key: "email", label: "Email", placeholder: "name@example.com" },
  { key: "nationality", label: "Nationality", placeholder: "Country" },
  { key: "idNumber", label: "ID / Passport Number", placeholder: "A12345678" },
  { key: "addressLine1", label: "Address", placeholder: "Street, building, unit" },
  { key: "city", label: "City", placeholder: "City" },
  { key: "serviceType", label: "Service Type", placeholder: "ID renewal" },
  { key: "preferredCenter", label: "Preferred Center", placeholder: "Main office" },
  { key: "appointmentDate", label: "Appointment Date", placeholder: "YYYY-MM-DD" },
  { key: "appointmentTime", label: "Appointment Time", placeholder: "HH:MM" },
  { key: "notes", label: "Notes", placeholder: "Extra details", multiline: true },
];

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
  const [isAiMode, setIsAiMode] = useState(false);
  const [formFillBusy, setFormFillBusy] = useState(false);
  const [formFillMessage, setFormFillMessage] = useState("");
  const [formData, setFormData] = useState<FormState>({
    fullName: "",
    dateOfBirth: "",
    phone: "",
    email: "",
    nationality: "",
    idNumber: "",
    addressLine1: "",
    city: "",
    serviceType: "",
    preferredCenter: "",
    appointmentDate: "",
    appointmentTime: "",
    notes: "",
  });

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

  const handleFormFieldChange = (key: keyof FormState, value: string) => {
    setFormData((current) => ({ ...current, [key]: value }));
  };

  const handleOpenAiMode = () => {
    setFormFillMessage("");
    setIsAiMode(true);
  };

  const handleExitAiMode = async () => {
    if (formFillBusy) {
      return;
    }

    try {
      setFormFillBusy(true);
      setStatus("processing");
      setErrorMessage("");
      const { formData: nextFormData, sessionId: nextSessionId } =
        await requestFormAutofill(sessionId, formData);
      if (nextSessionId) {
        setSessionId(nextSessionId);
      }
      setFormData(nextFormData);
      setFormFillMessage("Form updated from the AI conversation.");
      setIsAiMode(false);
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        getErrorMessage(error, "Unable to auto-fill the form.")
      );
    } finally {
      setFormFillBusy(false);
    }
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
      const { assistantReply: assistantText, sessionId: nextSessionId, tokenUsage: nextTokenUsage } =
        await requestAssistantReply(spokenText, sessionId, attachments);
      if (nextSessionId) {
        setSessionId(nextSessionId);
      }
      setTokenUsage(nextTokenUsage);
      setAttachments([]);
      setAssistantReply(assistantText);
      setStatus("speaking");
      await Speech.stop();

      Speech.speak(assistantText, {
        language: selectedLanguage,
        voice: selectedVoiceId || undefined,
        onDone: () => setStatus("ready"),
        onStopped: () => setStatus("ready"),
        onError: () => {
          setStatus("error");
          setErrorMessage("The device voice could not play back the assistant response.");
        },
      });
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        getErrorMessage(error, "The app could not get a response from the assistant.")
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

      const currentPermissions =
        await ExpoSpeechRecognitionModule.getPermissionsAsync();

      const permissions = currentPermissions.granted
        ? currentPermissions
        : await ExpoSpeechRecognitionModule.requestPermissionsAsync();

      if (!permissions.granted) {
        setStatus("error");
        const deniedMessage = permissions.canAskAgain
          ? "Microphone permission was denied. Tap again to allow it."
          : "Microphone permission is blocked. Reinstall the app to see the prompt again.";
        setErrorMessage(deniedMessage);
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

    try {
      setUploadBusy(true);
      setStatus("processing");
      setErrorMessage("");

      const { assistantReply: assistantText, sessionId: nextSessionId, tokenUsage: nextTokenUsage } =
        await requestAssistantReply(
          "Please use the attached files to help with my current service request.",
          sessionId,
          attachments
        );

      if (nextSessionId) {
        setSessionId(nextSessionId);
      }
      setTokenUsage(nextTokenUsage);

      setAttachments([]);
      setAssistantReply(assistantText);
      setStatus("speaking");
      await Speech.stop();

      Speech.speak(assistantText, {
        language: selectedLanguage,
        voice: selectedVoiceId || undefined,
        onDone: () => setStatus("ready"),
        onStopped: () => setStatus("ready"),
        onError: () => {
          setStatus("error");
          setErrorMessage("The device voice could not play back the assistant response.");
        },
      });
    } catch (error) {
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
  const buttonDisabled =
    UNSUPPORTED_PLATFORM ||
    status === "checking" ||
    status === "listening";
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.container}>
          {!isAiMode ? (
            <View style={styles.formCard}>
              <View style={styles.formHeader}>
                <View>
                  <Text style={styles.formTitle}>Application Form</Text>
                  <Text style={styles.formSubtitle}>Fill in your details or tap AI to help.</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={handleOpenAiMode}
                  style={({ pressed }) => [
                    styles.aiButton,
                    pressed ? styles.aiButtonPressed : null,
                  ]}
                >
                  <Text style={styles.aiButtonText}>AI</Text>
                </Pressable>
              </View>

              {FORM_FIELD_CONFIG.map((field) => (
                <View key={field.key} style={styles.formField}>
                  <Text style={styles.formLabel}>{field.label}</Text>
                  <TextInput
                    value={formData[field.key]}
                    onChangeText={(value) => handleFormFieldChange(field.key, value)}
                    placeholder={field.placeholder}
                    placeholderTextColor="#7b8fb0"
                    style={styles.formInput}
                    multiline={field.multiline}
                    textAlignVertical={field.multiline ? "top" : "center"}
                  />
                </View>
              ))}

              {formFillMessage ? (
                <Text style={styles.formMessage}>{formFillMessage}</Text>
              ) : null}
              {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
            </View>
          ) : (
            <>
              <View style={styles.controlsCard}>
                <View style={styles.aiHeaderRow}>
                  <Text style={styles.sectionLabel}>AI Agency</Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={formFillBusy}
                    onPress={() => void handleExitAiMode()}
                    style={({ pressed }) => [
                      styles.aiExitButton,
                      formFillBusy ? styles.resetButtonDisabled : null,
                      pressed && !formFillBusy ? styles.resetButtonPressed : null,
                    ]}
                  >
                    <Text style={styles.aiExitButtonText}>
                      {formFillBusy ? "Filling..." : "Return & Autofill"}
                    </Text>
                  </Pressable>
                </View>
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
            </>
          )}
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
      return "Sending the prompt to the assistant.";
    case "speaking":
      return "Speaking the assistant response.";
    case "error":
      return "The request could not be completed.";
    default:
      return "Waiting.";
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
    : await fetch(`${API_URL}/chat`, {
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

async function requestFormAutofill(sessionId: string, currentForm: FormState) {
  const prompt = buildFormFillPrompt(currentForm);
  const { assistantReply, sessionId: nextSessionId } = await requestAssistantReply(
    prompt,
    sessionId
  );

  const payload = extractJsonPayload(assistantReply);
  if (!payload || typeof payload !== "object") {
    throw new Error("The assistant returned invalid form data.");
  }

  const sanitized = sanitizeFormFillPayload(payload as FormFillPayload, currentForm);

  return {
    formData: sanitized,
    sessionId: nextSessionId,
  };
}

function buildFormFillPrompt(currentForm: FormState) {
  return `Use the existing conversation to fill out the application form fields.
Return only valid JSON with the exact keys listed below. Use null for unknown fields.
Do not include commentary or markdown.

Fields:
fullName, dateOfBirth, phone, email, nationality, idNumber, addressLine1, city,
serviceType, preferredCenter, appointmentDate, appointmentTime, notes, complete

Current form values (may be partial):
${JSON.stringify(currentForm, null, 2)}`;
}

function extractJsonPayload(reply: string): unknown | null {
  const trimmed = reply.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to extraction attempts.
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch {
      // Ignore and fall through.
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      return null;
    }
  }

  return null;
}

function sanitizeFormFillPayload(payload: FormFillPayload, current: FormState) {
  const keys = Object.keys(current) as Array<keyof FormState>;
  return keys.reduce((next, key) => {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return { ...next, [key]: value.trim() };
    }
    if (value === null) {
      return next;
    }
    return next;
  }, current);
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
  formCard: {
    padding: 20,
    borderRadius: 24,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#c7d4eb",
    gap: 16,
    shadowColor: "#0f3d91",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
  formHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  formTitle: {
    color: "#0f3d91",
    fontSize: 20,
    fontWeight: "800",
  },
  formSubtitle: {
    color: "#56709b",
    fontSize: 13,
    marginTop: 2,
  },
  aiButton: {
    minWidth: 56,
    height: 42,
    borderRadius: 16,
    backgroundColor: "#0f3d91",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  aiButtonPressed: {
    transform: [{ scale: 0.98 }],
  },
  aiButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 1.4,
  },
  formField: {
    gap: 8,
  },
  formLabel: {
    color: "#1c3f78",
    fontSize: 13,
    fontWeight: "700",
  },
  formInput: {
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#b9cae6",
    backgroundColor: "#f7faff",
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: "#10284c",
    fontSize: 14,
    fontWeight: "600",
  },
  formMessage: {
    color: "#0f3d91",
    fontSize: 13,
    fontWeight: "600",
  },
  aiHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  aiExitButton: {
    minHeight: 36,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#b9cae6",
    backgroundColor: "#edf4ff",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  aiExitButtonText: {
    color: "#0f3d91",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
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
  button: {
    minHeight: 54,
    borderRadius: 999,
    backgroundColor: "#0f3d91",
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
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
  },
  statusText: {
    color: "#34527f",
    textAlign: "center",
    fontSize: 13,
    lineHeight: 18,
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
