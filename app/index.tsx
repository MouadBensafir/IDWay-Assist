import { useEffect, useMemo, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Constants from "expo-constants";
import * as DocumentPicker from "expo-document-picker";
import * as Speech from "expo-speech";
import appConfig from "../config.json";
import { AttachmentPreview, ChatInterface, ChatMessage } from "./components/ChatInterface";
import { StreamAttachment, useStreamingChat } from "./hooks/useStreamingChat";
import { useVoiceLoop } from "./hooks/useVoiceLoop";

const API_URL = getBackendUrl();
const WORKFLOW_ID = getWorkflowId();
const DEFAULT_LOCALE = "en-US";

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState(DEFAULT_LOCALE);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [showAttachZone, setShowAttachZone] = useState(false);

  const { sendMessage, abortStream, partialText, clearPartial, waitingFirstToken, error } = useStreamingChat();

  useEffect(() => {
    void prepareVoiceDefaults();
    return () => {
      void Speech.stop();
    };
  }, []);

  const processUserPrompt = async (spokenText: string) => {
    const prompt = buildPrompt(spokenText);
    const userMessage: ChatMessage = { id: `${Date.now()}-u`, role: "user", text: spokenText };
    setMessages((current) => [...current, userMessage]);

    const result = await sendMessage({
      apiUrl: API_URL,
      workflowId: WORKFLOW_ID,
      workflowSessionId: sessionId || undefined,
      prompt,
      attachments: attachments as StreamAttachment[],
    });

    const nextSessionId =
      (result.payload?.workflow_session_id as string | undefined)?.trim() ||
      (result.payload?.session_id as string | undefined)?.trim() ||
      "";

    if (nextSessionId) {
      setSessionId(nextSessionId);
      void refreshAttachRequirement(nextSessionId);
    }

    const assistantText = (result.text || partialText).trim();
    clearPartial();
    setAttachments([]);

    if (assistantText) {
      setMessages((current) => [...current, { id: `${Date.now()}-a`, role: "assistant", text: assistantText }]);
      await voice.speakText(assistantText);
    }
  };

  const voice = useVoiceLoop({
    language: selectedLanguage,
    voiceId: selectedVoiceId,
    autoLoop: true,
    onUserFinalText: processUserPrompt,
    onBargeIn: () => {
      void Speech.stop();
      abortStream();
      clearPartial();
    },
  });

  async function prepareVoiceDefaults() {
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      const exact = voices.find((v) => v.language === DEFAULT_LOCALE) ?? voices[0];
      if (exact) {
        setSelectedLanguage(exact.language || DEFAULT_LOCALE);
        setSelectedVoiceId(exact.identifier || "");
      }
    } catch {
      setSelectedLanguage(DEFAULT_LOCALE);
      setSelectedVoiceId("");
    }
  }

  async function refreshAttachRequirement(workflowSessionId: string) {
    if (!workflowSessionId) {
      return;
    }

    try {
      const sessionResponse = await fetch(
        `${API_URL}/workflows/${encodeURIComponent(WORKFLOW_ID)}/sessions/${encodeURIComponent(workflowSessionId)}`
      );
      if (!sessionResponse.ok) {
        return;
      }
      const sessionPayload = (await sessionResponse.json()) as {
        steps?: { step_id: string; status: string; blueprint_id: string }[];
      };

      const inProgressStep = sessionPayload.steps?.find((step) => step.status === "in_progress" || step.status === "available");
      if (!inProgressStep?.blueprint_id) {
        setShowAttachZone(false);
        return;
      }

      const bpResponse = await fetch(
        `${API_URL}/dynamic/blueprints/${encodeURIComponent(inProgressStep.blueprint_id)}`
      );
      if (!bpResponse.ok) {
        setShowAttachZone(false);
        return;
      }

      const blueprint = (await bpResponse.json()) as { required_documents?: string[] };
      setShowAttachZone((blueprint.required_documents ?? []).length > 0);
    } catch {
      setShowAttachZone(false);
    }
  }

  const handlePickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["image/*", "application/pdf"],
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) {
      return;
    }

    const next = result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType || guessMimeType(asset.name),
    }));
    setAttachments((current) => [...current, ...next]);
  };

  const statusLine = useMemo(() => {
    if (voice.error || error) {
      return voice.error || error;
    }
    if (voice.isListening) {
      return "Listening...";
    }
    if (voice.isSpeaking) {
      return "Speaking...";
    }
    if (waitingFirstToken) {
      return "Waiting for assistant response...";
    }
    return "Ready";
  }, [error, voice.error, voice.isListening, voice.isSpeaking, waitingFirstToken]);

  if (Platform.OS === "web") {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.container}><Text>Use Android/iOS dev build for voice mode.</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <ChatInterface
          messages={messages}
          streamingText={partialText}
          waitingFirstToken={waitingFirstToken}
          isListening={voice.isListening}
          showAttachZone={showAttachZone}
          attachments={attachments}
          onPickFile={() => void handlePickFile()}
          onRemoveAttachment={(index) =>
            setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))
          }
          onToggleMic={() => void voice.toggleListening()}
        />
        <Text style={styles.statusText}>{statusLine}</Text>
      </View>
    </SafeAreaView>
  );
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

function getWorkflowId() {
  const explicitId = process.env.EXPO_PUBLIC_WORKFLOW_ID?.trim();
  if (explicitId) {
    return explicitId;
  }
  return appConfig.mobile?.workflowId?.trim() || "us_nonimmigrant_visa";
}

function guessMimeType(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#eef3fb" },
  container: { flex: 1 },
  statusText: {
    color: "#365683",
    fontSize: 13,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
});
