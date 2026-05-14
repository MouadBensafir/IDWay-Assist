import { useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type AttachmentPreview = {
  uri: string;
  name: string;
  type: string;
};

type Props = {
  messages: ChatMessage[];
  streamingText: string;
  waitingFirstToken: boolean;
  isListening: boolean;
  showAttachZone: boolean;
  attachments: AttachmentPreview[];
  onPickFile: () => void;
  onRemoveAttachment: (index: number) => void;
  onToggleMic: () => void;
};

export function ChatInterface({
  messages,
  streamingText,
  waitingFirstToken,
  isListening,
  showAttachZone,
  attachments,
  onPickFile,
  onRemoveAttachment,
  onToggleMic,
}: Props) {
  const scrollRef = useRef<ScrollView | null>(null);

  const rows = useMemo(() => {
    const base = [...messages];
    if (streamingText.trim()) {
      base.push({ id: "streaming", role: "assistant" as const, text: streamingText });
    }
    return base;
  }, [messages, streamingText]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [rows.length, streamingText]);

  return (
    <View style={styles.container}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.chatList}>
        {rows.map((message) => (
          <View
            key={message.id}
            style={[styles.bubble, message.role === "user" ? styles.userBubble : styles.assistantBubble]}
          >
            <Text style={message.role === "user" ? styles.userText : styles.assistantText}>{message.text}</Text>
          </View>
        ))}

        {waitingFirstToken ? (
          <View style={styles.waitRow}>
            <ActivityIndicator size="small" color="#1f4ea8" />
            <Text style={styles.waitText}>Assistant is thinking...</Text>
          </View>
        ) : null}
      </ScrollView>

      {showAttachZone ? (
        <View style={styles.attachCard}>
          <Pressable onPress={onPickFile} style={styles.attachButton}>
            <Ionicons name="attach" size={16} color="#1f4ea8" />
            <Text style={styles.attachText}>Attach documents</Text>
          </Pressable>
          <View style={styles.previewRow}>
            {attachments.map((file, index) => (
              <Pressable key={`${file.uri}-${index}`} onPress={() => onRemoveAttachment(index)} style={styles.previewChip}>
                {file.type.startsWith("image/") ? <Image source={{ uri: file.uri }} style={styles.thumb} /> : null}
                <Text numberOfLines={1} style={styles.previewName}>{file.name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <Pressable onPress={onToggleMic} style={[styles.micButton, isListening ? styles.micButtonActive : null]}>
        <Text style={styles.micText}>{isListening ? "Stop Mic" : "Start Mic"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 10 },
  chatList: { padding: 12, gap: 10 },
  bubble: { maxWidth: "86%", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9 },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#1f4ea8" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d7e2f5" },
  userText: { color: "#ffffff", fontSize: 15, lineHeight: 21 },
  assistantText: { color: "#13305f", fontSize: 15, lineHeight: 21 },
  waitRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 },
  waitText: { color: "#5776ab", fontSize: 13 },
  attachCard: { backgroundColor: "#f8fbff", borderWidth: 1, borderColor: "#d7e2f5", borderRadius: 12, marginHorizontal: 12, padding: 10, gap: 8 },
  attachButton: { flexDirection: "row", alignItems: "center", gap: 6 },
  attachText: { color: "#1f4ea8", fontWeight: "700" },
  previewRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  previewChip: { maxWidth: 160, borderWidth: 1, borderColor: "#c5d6f0", borderRadius: 10, padding: 6, backgroundColor: "#fff" },
  previewName: { color: "#244879", fontSize: 12 },
  thumb: { width: 36, height: 36, borderRadius: 6, marginBottom: 4 },
  micButton: { margin: 12, borderRadius: 12, backgroundColor: "#173e82", alignItems: "center", paddingVertical: 12 },
  micButtonActive: { backgroundColor: "#2d936c" },
  micText: { color: "#fff", fontWeight: "700" },
});
