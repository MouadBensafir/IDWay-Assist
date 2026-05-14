import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Constants from "expo-constants";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as Speech from "expo-speech";
import type { Voice } from "expo-speech";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStreamingChat, type Attachment, type ChatMessage } from "../hooks/useStreamingChat";
import { useVoiceLoop } from "../hooks/useVoiceLoop";
import appConfig from "../../config.json";

export function ChatInterface() {
  const apiUrl = getBackendUrl();
  const streaming = useStreamingChat(apiUrl);

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);

  const listRef = useRef<FlatList<ChatMessage>>(null);

  const onBargeIn = useCallback(() => {
    Speech.stop().catch(() => undefined);
    streaming.abortStream();
    streaming.clearPartialAssistant();
  }, [streaming]);

  const voice = useVoiceLoop({
    selectedVoice,
    onBargeIn,
    onUtterance: async (text: string) => streaming.sendMessage({ text, attachments: [] }),
  });

  useEffect(() => {
    (async () => {
      const available = await Speech.getAvailableVoicesAsync();
      setVoices(available);
      setSelectedVoice(available[0] || null);
      await voice.startListening();
    })();
    return () => {
      Speech.stop().catch(() => undefined);
      voice.stopListening();
      streaming.abortStream();
    };
    // startup/shutdown flow should run once for this screen mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, [streaming.messages, streaming.partialAssistantText]);

  const canAttach = streaming.requiredDocuments.length > 0;

  const visibleMessages = useMemo(() => {
    const out = [...streaming.messages];
    if (streaming.partialAssistantText.trim()) {
      out.push({ id: "partial", role: "assistant", text: streaming.partialAssistantText });
    }
    return out;
  }, [streaming.messages, streaming.partialAssistantText]);

  const pickFiles = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["image/*", "application/pdf"],
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;

    const next = await Promise.all(result.assets.map(async (asset) => {
      const mime = asset.mimeType || guessMimeType(asset.name || "");
      if (mime.startsWith("image/")) {
        const compressed = await ImageManipulator.manipulateAsync(asset.uri, [], {
          compress: 0.7,
          format: ImageManipulator.SaveFormat.JPEG,
        });
        return {
          uri: compressed.uri,
          name: asset.name || `image-${Date.now()}.jpg`,
          type: "image/jpeg",
        } as Attachment;
      }
      return {
        uri: asset.uri,
        name: asset.name || `document-${Date.now()}.pdf`,
        type: "application/pdf",
      } as Attachment;
    }));

    setAttachments((prev) => [...prev, ...next]);
  }, []);

  const sendTyped = useCallback(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    voice.stopListening();
    voice.setStatus("processing");
    const reply = await streaming.sendMessage({ text, attachments });
    setInput("");
    setAttachments([]);
    await voice.speakAndResume(reply);
  }, [attachments, input, streaming, voice]);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{streaming.workflowTitle || "IDWay Assist"}</Text>
        <Text style={styles.subtitle}>{streaming.workflowId || "Workflow auto-detect"}</Text>
      </View>

      <FlatList
        ref={listRef}
        data={visibleMessages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messages}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === "user" ? styles.userBubble : styles.assistantBubble]}>
            <Text style={styles.bubbleText}>{item.text}</Text>
          </View>
        )}
      />

      {streaming.isWaitingFirstToken ? (
        <View style={styles.waitingRow}>
          <ActivityIndicator size="small" />
          <Text style={styles.waitingText}>Waiting for first token…</Text>
        </View>
      ) : null}

      {canAttach ? (
        <Pressable style={styles.attachCard} onPress={pickFiles}>
          <Text style={styles.attachTitle}>Attach documents</Text>
          <Text style={styles.attachHint}>{streaming.requiredDocuments.join(" • ")}</Text>
        </Pressable>
      ) : null}

      {attachments.length > 0 ? (
        <View style={styles.previewRow}>
          {attachments.map((a, i) => (
            <View key={`${a.uri}-${i}`} style={styles.previewItem}>
              {a.type.startsWith("image/") ? <Image source={{ uri: a.uri }} style={styles.thumb} /> : <Text style={styles.pdf}>PDF</Text>}
              <Text numberOfLines={1} style={styles.fileName}>{a.name}</Text>
              <Pressable onPress={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}>
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {streaming.error || voice.error ? <Text style={styles.error}>{streaming.error || voice.error}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Type message"
          multiline
        />
        <View style={styles.actions}>
          <Pressable style={styles.btn} onPress={voice.toggleListening}>
            <Text>{voice.status === "listening" ? "Stop mic" : "Start mic"}</Text>
          </Pressable>
          {canAttach ? (
            <Pressable style={styles.btn} onPress={pickFiles}>
              <Text>📎</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.send} onPress={sendTyped}>
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>{`Voice: ${selectedVoice?.name || "default"} · ${voices.length} voices`}</Text>
      </View>
    </SafeAreaView>
  );
}

function getBackendUrl() {
  const explicitUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (explicitUrl) return explicitUrl.replace(/\/$/, "");

  const configUrl = appConfig.mobile?.backendUrl;
  const hostUri = (Constants.expoConfig?.hostUri || "").split(":")[0];
  if (configUrl?.default) return configUrl.default.replace(/\/$/, "");
  if (hostUri) return `http://${hostUri}:8001`;
  return "http://127.0.0.1:8001";
}

function guessMimeType(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f8fb" },
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, borderBottomWidth: 1, borderColor: "#d5dbe8" },
  title: { fontSize: 18, fontWeight: "700", color: "#102a43" },
  subtitle: { fontSize: 12, color: "#486581" },
  messages: { padding: 16, gap: 10 },
  bubble: { maxWidth: "84%", borderRadius: 12, padding: 10 },
  userBubble: { backgroundColor: "#1e40af", alignSelf: "flex-end" },
  assistantBubble: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d5dbe8", alignSelf: "flex-start" },
  bubbleText: { color: "#111827", fontSize: 15, lineHeight: 20 },
  waitingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  waitingText: { color: "#334e68" },
  attachCard: { marginHorizontal: 16, marginBottom: 8, borderWidth: 1, borderColor: "#c9d5ea", borderRadius: 10, padding: 10, backgroundColor: "#eef4ff" },
  attachTitle: { fontWeight: "600", color: "#102a43" },
  attachHint: { marginTop: 2, fontSize: 12, color: "#486581" },
  previewRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  previewItem: { width: 86, borderWidth: 1, borderColor: "#d5dbe8", borderRadius: 8, padding: 6, backgroundColor: "#fff" },
  thumb: { width: 72, height: 72, borderRadius: 4, backgroundColor: "#e5e7eb" },
  pdf: { width: 72, height: 72, textAlign: "center", textAlignVertical: "center", backgroundColor: "#f3f4f6", borderRadius: 4, lineHeight: 72 },
  fileName: { fontSize: 10, marginTop: 4, color: "#334e68" },
  remove: { fontSize: 10, marginTop: 2, color: "#b91c1c" },
  error: { color: "#b91c1c", paddingHorizontal: 16, paddingBottom: 6 },
  composer: { borderTopWidth: 1, borderColor: "#d5dbe8", padding: 12, gap: 8 },
  input: { minHeight: 46, maxHeight: 120, borderWidth: 1, borderColor: "#d5dbe8", borderRadius: 8, paddingHorizontal: 10, paddingTop: 8, backgroundColor: "#fff" },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  btn: { paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#e9eef7", borderRadius: 8 },
  send: { paddingHorizontal: 16, paddingVertical: 9, backgroundColor: "#0f4c81", borderRadius: 8 },
  sendText: { color: "#fff", fontWeight: "700" },
  footer: { paddingBottom: 8 },
  footerText: { textAlign: "center", fontSize: 11, color: "#627d98" },
});
