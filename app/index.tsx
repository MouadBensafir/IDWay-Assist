import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Constants from "expo-constants";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import * as Speech from "expo-speech";
import type { Voice } from "expo-speech";
import {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionModule,
  ExpoSpeechRecognitionResultEvent,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import appConfig from "../config.json";

const API_URL = getBackendUrl();
const WORKFLOW_ID = getWorkflowId();

type Status =
  | "setup" | "idle" | "listening" | "processing" | "speaking" | "error";

type Message = {
  role: "user" | "assistant";
  text: string;
  files?: Attachment[];
};

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
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
};

const COLORS = {
  dark: {
    bg: "#080f1e", surface: "#0e1a30", surface2: "#14243f",
    border: "#1e3358", borderHi: "#2a4a7a",
    ink: "#e8eef8", inkDim: "#7a9bc4", inkFaint: "#334d6e",
    userBg: "#192c70", userInk: "#c8d8f5",
    botBg: "#0e1a30", botBorder: "#1e3358",
    red: "#d0142c", redDim: "#a80f22",
    navy: "#192c70", navyMid: "#243d99", navyLight: "#2e4eb5",
  },
  light: {
    bg: "#f0f4fb", surface: "#ffffff", surface2: "#e8eef8",
    border: "#c5d4ea", borderHi: "#a0bcdf",
    ink: "#0c1e3c", inkDim: "#3d5c8a", inkFaint: "#b0c4de",
    userBg: "#192c70", userInk: "#d8e8ff",
    botBg: "#ffffff", botBorder: "#c5d4ea",
    red: "#d0142c", redDim: "#a80f22",
    navy: "#192c70", navyMid: "#243d99", navyLight: "#2e4eb5",
  },
};

export default function ChatScreen() {
  const [colorScheme, setColorScheme] = useState<"dark" | "light">("dark");
  const [status, setStatus] = useState<Status>("setup");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [workflowId, setWorkflowIdState] = useState("");
  const [workflowTitle, setWorkflowTitle] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>(EMPTY_TOKEN_USAGE);
  const [error, setError] = useState("");
  const [infoExpanded, setInfoExpanded] = useState(false);

  // Voice selector
  const [availableVoices, setAvailableVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);
  const [showVoicePicker, setShowVoicePicker] = useState(false);

  const flatListRef = useRef<FlatList>(null);
  const sessionIdRef = useRef("");
  const transcriptRef = useRef("");
  const statusRef = useRef<Status>("setup");
  const abortRef = useRef(false);

  const c = COLORS[colorScheme];

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { statusRef.current = status; }, [status]);

  // ── STT events ──
  useSpeechRecognitionEvent("result", (e: ExpoSpeechRecognitionResultEvent) => {
    const t = e.results[0]?.transcript?.trim();
    if (!t) return;
    transcriptRef.current = t;
  });

  useSpeechRecognitionEvent("end", () => {
    if (statusRef.current !== "listening") return;
    const t = transcriptRef.current;
    if (!t) { restartListening(); return; }
    handleUserTranscript(t);
  });

  useSpeechRecognitionEvent("error", (e: ExpoSpeechRecognitionErrorEvent) => {
    setStatus("idle");
    setError(e.message || "Speech recognition error.");
    setTimeout(restartListening, 2000);
  });

  // ── Initialize on mount ──
  useEffect(() => {
    (async () => {
      const voices = await Speech.getAvailableVoicesAsync();
      setAvailableVoices(voices);
      if (voices.length > 0) setSelectedVoice(voices[0]);
    })();
    return () => {
      abortRef.current = true;
      Speech.stop().catch(() => {});
      ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  // ── Helpers ──
  const scrollToEnd = useCallback(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }, []);

  const startSTT = async () => {
    try {
      const perms = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perms.granted) { setError("Microphone permission denied."); return; }
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
      setStatus("idle");
    }
  };

  const restartListening = () => {
    if (abortRef.current) return;
    if (statusRef.current === "speaking") return;
    if (statusRef.current === "processing") return;
    startSTT();
  };

  const stopSTT = () => {
    try { ExpoSpeechRecognitionModule.abort(); } catch {}
  };

  const handleUserTranscript = (text: string) => {
    stopSTT();
    setStatus("processing");
    const userMsg: Message = { role: "user", text };
    setMessages((prev) => [...prev, userMsg]);
    scrollToEnd();
    sendToAPI(text, []);
  };

  const sendToAPI = async (text: string, files: Attachment[]) => {
    const fd = new FormData();
    fd.append("prompt", text);
    if (sessionIdRef.current) fd.append("workflow_session_id", sessionIdRef.current);
    for (const a of files) {
      fd.append("file", { uri: a.uri, name: a.name, type: a.type } as never);
    }

    let responseText = "";

    try {
      const res = await fetch(`${API_URL}/workflows/chat/stream`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(`Backend error: ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === "token") {
                responseText += data.token || "";
              } else if (currentEvent === "done") {
                const nextSessionId = (data.workflow_session_id || "").trim();
                const nextWorkflowId = (data.workflow_id || "").trim();
                const nextTitle = (data.workflow_title || "").trim();
                if (nextSessionId) setSessionId(nextSessionId);
                if (nextWorkflowId) setWorkflowIdState(nextWorkflowId);
                if (nextTitle) setWorkflowTitle(nextTitle);
                if (data.token_usage) setTokenUsage(normalizeTokenUsage(data.token_usage));

                if (responseText.trim()) {
                  setMessages((prev) => [...prev, { role: "assistant", text: responseText.trim() }]);
                  scrollToEnd();
                  setStatus("speaking");
                  await Speech.stop();
                  Speech.speak(responseText.trim(), {
                    voice: selectedVoice?.identifier || undefined,
                    onDone: () => {
                      if (!abortRef.current) startSTT();
                    },
                    onStopped: () => {
                      if (!abortRef.current) startSTT();
                    },
                    onError: () => {
                      setError("TTS playback failed.");
                      if (!abortRef.current) startSTT();
                    },
                  });
                } else {
                  if (!abortRef.current) startSTT();
                }
              } else if (currentEvent === "error") {
                throw new Error(data.detail || "Backend streaming error.");
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message.startsWith("Backend")) throw parseErr;
            }
            currentEvent = "";
          }
        }
      }

      if (responseText.trim()) {
        setMessages((prev) => [...prev, { role: "assistant", text: responseText.trim() }]);
        scrollToEnd();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      setStatus("idle");
      setTimeout(restartListening, 3000);
    }
  };

  // ── Text send ──
  const sendMessage = async () => {
    const text = input.trim();
    if (!text && !attachments.length) return;
    const outText = text || "Please process the attached file(s).";
    const outFiles = [...attachments];
    setMessages((prev) => [...prev, { role: "user", text: outText, files: outFiles }]);
    setInput("");
    setAttachments([]);
    setError("");
    setStatus("processing");
    scrollToEnd();
    stopSTT();
    await sendToAPI(outText, outFiles);
  };

  const handleReset = async () => {
    abortRef.current = true;
    await Speech.stop().catch(() => {});
    ExpoSpeechRecognitionModule.abort();
    if (sessionId) {
      try {
        await fetch(`${API_URL}/workflows/${encodeURIComponent(WORKFLOW_ID)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      } catch {}
    }
    setSessionId("");
    setWorkflowIdState("");
    setWorkflowTitle("");
    setMessages([]);
    setAttachments([]);
    setTokenUsage(EMPTY_TOKEN_USAGE);
    setError("");
    abortRef.current = false;
    setStatus("idle");
    startSTT();
  };

  const handleTakePhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
      if (result.canceled || !result.assets[0]) return;
      const compressed = await ImageManipulator.manipulateAsync(result.assets[0].uri, [], { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG });
      setAttachments((prev) => [...prev, { uri: compressed.uri, name: `camera-${Date.now()}.jpg`, type: "image/jpeg" }]);
    } catch { setError("Unable to capture a photo."); }
  };

  const handlePickFiles = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ["image/*", "application/pdf"], multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      const next = await Promise.all(result.assets.map(async (asset) => {
        const mime = asset.mimeType || guessMimeType(asset.name);
        if (mime.startsWith("image/")) {
          const compressed = await ImageManipulator.manipulateAsync(asset.uri, [], { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG });
          return { uri: compressed.uri, name: asset.name || `image-${Date.now()}.jpg`, type: "image/jpeg" };
        }
        return { uri: asset.uri, name: asset.name || `document-${Date.now()}.pdf`, type: mime };
      }));
      setAttachments((prev) => [...prev, ...next]);
    } catch { setError("Unable to pick a file."); }
  };

  const toggleTheme = () => setColorScheme((p) => p === "dark" ? "light" : "dark");

  const startConversation = () => {
    setStatus("idle");
    startSTT();
  };

  // ── Setup screen ──
  if (status === "setup") {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: c.bg }]}>
        <View style={styles.setupContainer}>
          <Text style={[styles.setupTitle, { color: c.ink }]}>Welcome to IDWay</Text>
          <Text style={[styles.setupSub, { color: c.inkDim }]}>
            Select your preferred voice, then start the conversation.
          </Text>

          <View style={[styles.setupCard, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.setupSectionLabel, { color: c.inkDim }]}>Voice</Text>
            <Pressable
              onPress={() => setShowVoicePicker(true)}
              style={({ pressed }) => [styles.setupSelector, { backgroundColor: c.surface2, borderColor: c.borderHi }, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.setupSelectorText, { color: c.ink }]}>{selectedVoice ? `${selectedVoice.name} (${selectedVoice.language})` : "System default"}</Text>
              <Text style={{ color: c.inkDim, fontSize: 12 }}>Change</Text>
            </Pressable>
          </View>

          <Pressable
            onPress={startConversation}
            disabled={!selectedVoice}
            style={({ pressed }) => [styles.startBtn, { backgroundColor: c.navy }, pressed && { opacity: 0.8 }]}
          >
            <Text style={styles.startBtnText}>Start Conversation</Text>
          </Pressable>

          <VoicePickerModal
            visible={showVoicePicker}
            voices={availableVoices}
            selectedVoice={selectedVoice}
            onSelect={(v) => { setSelectedVoice(v); setShowVoicePicker(false); }}
            onClose={() => setShowVoicePicker(false)}
            colors={c}
          />
        </View>
      </SafeAreaView>
    );
  }

  // ── Main chat screen ──
  const hasMessages = messages.length > 0;
  const displayTitle = workflowTitle || "E-Service Workflow Runtime";
  const displaySubtitle = workflowId ? `Detected workflow: ${workflowId}` : "Secure document and identity services";
  const isListening = status === "listening";
  const isProcessing = status === "processing";
  const isSpeaking = status === "speaking";

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: c.bg }]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={styles.headerLeft}>
            <View style={[styles.statusDot, { backgroundColor: isListening ? "#22d36b" : isProcessing ? "#f0ad4e" : isSpeaking ? "#5bc0de" : "#22d36b" }]} />
            <View>
              <Text style={[styles.headerTitle, { color: c.ink }]}>{displayTitle}</Text>
              <Text style={[styles.headerSubtitle, { color: c.inkDim }]}>{displaySubtitle}</Text>
            </View>
          </View>
          <Pressable onPress={() => setInfoExpanded((v) => !v)} style={({ pressed }) => [styles.infoToggle, pressed && { opacity: 0.7 }]}>
            <Text style={{ color: c.red, fontSize: 12, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" }}>
              {sessionId ? "Session" : "Info"}
            </Text>
          </Pressable>
        </View>

        {/* Info panel */}
        {infoExpanded && (
          <View style={[styles.infoPanel, { backgroundColor: c.surface, borderColor: c.border }]}>
            <View style={styles.infoRow}>
              <Text style={[styles.infoKey, { color: c.inkDim }]}>Session ID</Text>
              <Text style={[styles.infoVal, { color: c.ink }]} numberOfLines={1}>{sessionId || "—"}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={[styles.infoKey, { color: c.inkDim }]}>Workflow</Text>
              <Text style={[styles.infoVal, { color: c.ink }]} numberOfLines={1}>{workflowTitle || workflowId || "Auto-detect"}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={[styles.infoKey, { color: c.inkDim }]}>Tokens</Text>
              <Text style={[styles.infoVal, { color: c.ink }]}>{formatTokenUsage(tokenUsage)}</Text>
            </View>
            <View style={styles.infoActions}>
              <Pressable onPress={toggleTheme} style={({ pressed }) => [styles.infoBtn, pressed && { opacity: 0.7 }]}>
                <Text style={{ color: c.navyMid, fontSize: 11, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase" }}>
                  {colorScheme === "dark" ? "Light mode" : "Dark mode"}
                </Text>
              </Pressable>
              <Pressable onPress={handleReset} disabled={!sessionId} style={({ pressed }) => [styles.infoBtn, !sessionId && { opacity: 0.5 }, pressed && sessionId && { opacity: 0.7 }]}>
                <Text style={[styles.infoBtnDanger, { color: c.red }]}>End Conversation</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Welcome */}
        {!hasMessages && !isProcessing && !isSpeaking && (
          <View style={styles.welcome}>
            <Text style={[styles.welcomeTitle, { color: c.ink }]}>Welcome to IDWay</Text>
            <Text style={[styles.welcomeSub, { color: c.inkDim }]}>
              Speak naturally — the agent will listen, respond, and continue the conversation.
            </Text>
            {isListening && (
              <View style={styles.listeningIndicator}>
                <ListeningAnimation />
                <Text style={{ color: c.inkDim, fontSize: 13, marginTop: 8 }}>Listening…</Text>
              </View>
            )}
          </View>
        )}

        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(_, i) => String(i)}
          style={styles.messagesList}
          contentContainerStyle={[styles.messagesContent, !hasMessages && styles.messagesEmpty]}
          renderItem={({ item }) => (
            <View style={[styles.msgWrap, item.role === "user" ? styles.msgWrapUser : styles.msgWrapAssistant, { maxWidth: "82%" }]}>
              <Text style={[styles.msgRole, { color: c.inkFaint }]}>{item.role === "user" ? "You" : "IDWay Agent"}</Text>
              <View style={[styles.msgBubble, item.role === "user"
                ? [styles.msgBubbleUser, { backgroundColor: c.userBg }]
                : [styles.msgBubbleAssistant, { backgroundColor: c.botBg, borderColor: c.botBorder, borderTopColor: c.navyMid }]
              ]}>
                <Text style={[styles.msgText, { color: item.role === "user" ? c.userInk : c.ink }]}>{item.text}</Text>
              </View>
              {item.files && item.files.length > 0 && (
                <View style={styles.msgFiles}>
                  {item.files.map((f: Attachment, i: number) => (
                    <View key={i} style={[styles.msgFileChip, { backgroundColor: "rgba(255,255,255,0.1)", borderColor: "rgba(255,255,255,0.18)" }]}>
                      <Text style={{ color: c.userInk, fontSize: 11, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase" }}>{f.name}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}
          onContentSizeChange={scrollToEnd}
        />

        {/* Status indicator */}
        {(isProcessing || isSpeaking) && (
          <View style={[styles.statusBar, { backgroundColor: c.surface, borderColor: c.border }]}>
            {isProcessing ? (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={c.navyLight} />
                <Text style={[styles.statusText, { color: c.inkDim, marginLeft: 8 }]}>Agent is thinking…</Text>
              </View>
            ) : (
              <View style={styles.statusRow}>
                <SpeakingIndicator />
                <Text style={[styles.statusText, { color: c.inkDim, marginLeft: 8 }]}>Speaking…</Text>
              </View>
            )}
          </View>
        )}

        {/* Error */}
        {error ? <Text style={[styles.errorText, { color: c.red }]}>{error}</Text> : null}

        {/* Attachments */}
        {attachments.length > 0 && (
          <View style={[styles.attachRow, { backgroundColor: c.surface }]}>
            {attachments.map((a, i) => (
              <View key={i} style={[styles.attachChip, { backgroundColor: c.surface2, borderColor: c.borderHi }]}>
                <Text style={[styles.attachChipText, { color: c.ink }]} numberOfLines={1}>{a.name}</Text>
                <Pressable onPress={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} hitSlop={8}>
                  <Text style={{ color: c.red, fontSize: 14, fontWeight: "700" }}>✕</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* Composer */}
        <View style={[styles.composerWrap, { backgroundColor: c.bg }]}>
          <View style={[styles.composer, { backgroundColor: c.surface, borderColor: c.border, borderTopColor: c.navyMid }]}>
            <TextInput
              style={[styles.input, { color: c.ink }]}
              placeholder="Type a message or speak…"
              placeholderTextColor={c.inkFaint}
              multiline
              value={input}
              onChangeText={setInput}
              editable={!isProcessing}
            />
            <View style={styles.composerRow}>
              <View style={styles.composerLeft}>
                <Pressable onPress={handleTakePhoto} disabled={isProcessing} style={({ pressed }) => [styles.composerBtn, pressed && { opacity: 0.7 }]}>
                  <Text style={[styles.composerBtnText, { color: c.inkDim }]}>📷 Photo</Text>
                </Pressable>
                <Pressable onPress={handlePickFiles} disabled={isProcessing} style={({ pressed }) => [styles.composerBtn, pressed && { opacity: 0.7 }]}>
                  <Text style={[styles.composerBtnText, { color: c.inkDim }]}>📎 File</Text>
                </Pressable>
                {!isListening && !isProcessing && !isSpeaking && (
                  <Pressable onPress={startSTT} style={({ pressed }) => [styles.composerBtn, pressed && { opacity: 0.7 }]}>
                    <Text style={[styles.composerBtnText, { color: c.inkDim }]}>🎤 Speak</Text>
                  </Pressable>
                )}
              </View>
              <Pressable
                onPress={sendMessage}
                disabled={isProcessing || (!input.trim() && !attachments.length)}
                style={({ pressed }) => [styles.sendBtn, { backgroundColor: c.navy }, (isProcessing || (!input.trim() && !attachments.length)) && { opacity: 0.45 }, pressed && { transform: [{ scale: 0.97 }] }]}
              >
                <Text style={styles.sendBtnText}>{isProcessing ? "…" : "Send"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Listening Animation ──
function ListeningAnimation() {
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(anim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
      Animated.timing(anim, { toValue: 1, duration: 600, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {[0, 1, 2].map((i) => (
        <Animated.View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#22d36b", opacity: anim }} />
      ))}
    </View>
  );
}

// ── Speaking Indicator (soundwave bars) ──
function SpeakingIndicator() {
  const bars = useRef([0, 1, 2, 3, 4].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    const anims = bars.map((bar, i) =>
      Animated.loop(Animated.sequence([
        Animated.timing(bar, { toValue: 1, duration: 400 + i * 80, useNativeDriver: true }),
        Animated.timing(bar, { toValue: 0.3, duration: 400 + i * 80, useNativeDriver: true }),
      ]))
    );
    Animated.parallel(anims).start();
    return () => { anims.forEach((a) => a.stop()); };
  }, [bars]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 20 }}>
      {bars.map((bar, i) => (
        <Animated.View key={i} style={[speakingStyles.bar, { opacity: bar, height: 8 + i * 3 }]} />
      ))}
    </View>
  );
}

const speakingStyles = StyleSheet.create({
  bar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: "#243d99",
  },
});

// ── Voice Picker Modal ──
function VoicePickerModal({ visible, voices, selectedVoice, onSelect, onClose, colors }: {
  visible: boolean;
  voices: Voice[];
  selectedVoice: Voice | null;
  onSelect: (voice: Voice) => void;
  onClose: () => void;
  colors: Record<string, string>;
}) {
  const grouped = voices.reduce<Record<string, Voice[]>>((acc, v) => {
    (acc[v.language] = acc[v.language] || []).push(v);
    return acc;
  }, {});
  const languages = Object.keys(grouped).sort();

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={[modalStyles.backdrop, { backgroundColor: "rgba(8,15,30,0.6)" }]}>
        <Pressable style={modalStyles.dismiss} onPress={onClose} />
        <View style={[modalStyles.card, { backgroundColor: colors.surface }]}>
          <Text style={[modalStyles.title, { color: colors.ink }]}>Choose Voice</Text>
          <FlatList
            data={languages}
            keyExtractor={(l) => l}
            style={{ maxHeight: 400 }}
            renderItem={({ item: lang }) => (
              <View>
                <Text style={[modalStyles.langLabel, { color: colors.inkDim }]}>{lang}</Text>
                {grouped[lang].map((voice) => {
                  const selected = selectedVoice?.identifier === voice.identifier;
                  return (
                    <Pressable
                      key={voice.identifier}
                      onPress={() => onSelect(voice)}
                      style={({ pressed }) => [modalStyles.option, selected && { backgroundColor: colors.surface2 }, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={[modalStyles.optionText, { color: colors.ink }, selected && { fontWeight: "800" }]}>
                        {voice.name} ({voice.quality})
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          />
          <Pressable onPress={onClose} style={[modalStyles.closeBtn, { backgroundColor: colors.navy }]}>
            <Text style={modalStyles.closeText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end" },
  dismiss: { flex: 1 },
  card: { maxHeight: "70%", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 28, gap: 14 },
  title: { fontSize: 18, fontWeight: "800" },
  langLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase", marginTop: 12, marginBottom: 4, paddingHorizontal: 4 },
  option: { minHeight: 44, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, justifyContent: "center" },
  optionText: { fontSize: 14, fontWeight: "500" },
  closeBtn: { minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  closeText: { color: "#ffffff", fontSize: 14, fontWeight: "800" },
});

// ── Helper functions ──
function normalizeTokenUsage(tokenUsage?: Partial<TokenUsage> | null): TokenUsage {
  return {
    prompt_tokens: Math.max(0, Number(tokenUsage?.prompt_tokens || 0)),
    completion_tokens: Math.max(0, Number(tokenUsage?.completion_tokens || 0)),
    total_tokens: Math.max(0, Number(tokenUsage?.total_tokens || 0)),
  };
}

function formatTokenUsage(tokenUsage: TokenUsage) {
  return `${tokenUsage.total_tokens} total · ${tokenUsage.prompt_tokens} prompt · ${tokenUsage.completion_tokens} completion`;
}

function getBackendUrl() {
  const explicitUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (explicitUrl) return explicitUrl.replace(/\/$/, "");
  const configUrl = appConfig.mobile?.backendUrl;
  if (Platform.OS === "android") return (configUrl?.android || configUrl?.default || "").replace(/\/$/, "");
  if (Platform.OS === "ios") return (configUrl?.ios || configUrl?.default || "").replace(/\/$/, "");
  return (configUrl?.default || "").replace(/\/$/, "");
}

function getWorkflowId() {
  const explicit = process.env.EXPO_PUBLIC_WORKFLOW_ID?.trim();
  if (explicit) return explicit;
  return appConfig.mobile?.workflowId?.trim() || "us_nonimmigrant_visa";
}

function guessMimeType(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

// ── Styles ──
const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  flex: { flex: 1 },

  // Setup
  setupContainer: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 32, gap: 20 },
  setupTitle: { fontSize: 28, fontWeight: "800", letterSpacing: 0.5, textAlign: "center" },
  setupSub: { fontSize: 14, lineHeight: 22, textAlign: "center", maxWidth: 340 },
  setupCard: { width: "100%", padding: 18, borderRadius: 14, borderWidth: 1, gap: 12 },
  setupSectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" },
  setupSelector: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, borderWidth: 1 },
  setupSelectorText: { fontSize: 14, fontWeight: "600", flex: 1 },
  startBtn: { width: "100%", paddingVertical: 16, borderRadius: 12, alignItems: "center" },
  startBtnText: { color: "#ffffff", fontSize: 16, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase" },

  // Header
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, height: 52, borderBottomWidth: 1 },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  headerTitle: { fontSize: 15, fontWeight: "700", letterSpacing: 0.5 },
  headerSubtitle: { fontSize: 11, marginTop: 1 },
  infoToggle: { paddingHorizontal: 8, paddingVertical: 6 },

  // Info panel
  infoPanel: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, gap: 8 },
  infoRow: { flexDirection: "row", gap: 8 },
  infoKey: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase", width: 72 },
  infoVal: { fontSize: 12, fontWeight: "500", flex: 1 },
  infoActions: { flexDirection: "row", gap: 12, marginTop: 4 },
  infoBtn: { paddingVertical: 6, paddingHorizontal: 10 },
  infoBtnDanger: { fontSize: 11, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },

  // Welcome
  welcome: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 12 },
  welcomeTitle: { fontSize: 26, fontWeight: "800", letterSpacing: 0.5, textAlign: "center" },
  welcomeSub: { fontSize: 14, lineHeight: 22, textAlign: "center", maxWidth: 360 },
  listeningIndicator: { alignItems: "center", marginTop: 16 },

  // Messages
  messagesList: { flex: 1 },
  messagesContent: { padding: 16, paddingBottom: 8, gap: 14 },
  messagesEmpty: { flex: 1 },
  msgWrap: { gap: 4 },
  msgWrapUser: { alignSelf: "flex-end", alignItems: "flex-end" },
  msgWrapAssistant: { alignSelf: "flex-start", alignItems: "flex-start" },
  msgRole: { fontSize: 10, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase" },
  msgBubble: { paddingVertical: 11, paddingHorizontal: 15, borderRadius: 10 },
  msgBubbleUser: { borderLeftWidth: 3, borderLeftColor: "#d0142c", borderTopLeftRadius: 4, borderBottomRightRadius: 10 },
  msgBubbleAssistant: { borderWidth: 1, borderTopWidth: 2, borderTopLeftRadius: 10, borderBottomLeftRadius: 4 },
  msgText: { fontSize: 15, lineHeight: 22 },
  msgFiles: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 4 },
  msgFileChip: { paddingVertical: 3, paddingHorizontal: 9, borderRadius: 6, borderWidth: 1 },

  // Status bar
  statusBar: { paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  statusRow: { flexDirection: "row", alignItems: "center" },
  statusText: { fontSize: 13, fontWeight: "500" },

  // Error
  errorText: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingBottom: 4 },

  // Attachments
  attachRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 16, paddingVertical: 8 },
  attachChip: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1 },
  attachChipText: { fontSize: 12, fontWeight: "600", maxWidth: 160 },

  // Composer
  composerWrap: { paddingHorizontal: 12, paddingBottom: 12, paddingTop: 4 },
  composer: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 8 },
  input: { minHeight: 44, maxHeight: 120, fontSize: 15, lineHeight: 22, textAlignVertical: "top" },
  composerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  composerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  composerBtn: { paddingVertical: 6, paddingHorizontal: 10 },
  composerBtnText: { fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  sendBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 6 },
  sendBtnText: { color: "#ffffff", fontSize: 13, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase" },
});
