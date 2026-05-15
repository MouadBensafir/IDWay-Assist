import { useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useConversationHistory } from "./context/ConversationContext";

export default function ConversationScreen() {
  const { history } = useConversationHistory();
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  const handleAttachmentPress = (uri?: string, type?: string, name?: string) => {
    if (!uri) {
      return;
    }
    const lowerName = name?.toLowerCase() || "";
    const isImage =
      (type && type.startsWith("image/")) ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg") ||
      lowerName.endsWith(".png") ||
      lowerName.endsWith(".webp");
    if (isImage) {
      setPreviewUri(uri);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.title}>Conversation</Text>
        <Text style={styles.subtitle}>Full session transcript</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {history.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptySubtitle}>Start speaking to see the transcript here.</Text>
          </View>
        ) : (
          history.map((item) => (
            <View
              key={item.id}
              style={item.role === "user" ? styles.userBubble : styles.assistantBubble}
            >
              <Text style={styles.roleLabel}>
                {item.role === "user" ? "You" : "Assistant"}
              </Text>
              <Text style={styles.messageText}>{item.text}</Text>
              {item.attachments?.length ? (
                <View style={styles.attachmentRow}>
                  {item.attachments.map((attachment) => (
                    <Pressable
                      key={`${item.id}-${attachment.name}`}
                      style={styles.attachmentChip}
                      onPress={() =>
                        handleAttachmentPress(
                          attachment.uri,
                          attachment.type,
                          attachment.name
                        )
                      }
                    >
                      <Text style={styles.attachmentText}>{attachment.name}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>
      <Modal
        animationType="fade"
        transparent
        visible={Boolean(previewUri)}
        onRequestClose={() => setPreviewUri(null)}
      >
        <View style={styles.previewBackdrop}>
          <Pressable style={styles.previewDismiss} onPress={() => setPreviewUri(null)} />
          <View style={styles.previewCard}>
            {previewUri ? (
              <Image source={{ uri: previewUri }} style={styles.previewImage} />
            ) : null}
          </View>
          <Pressable style={styles.previewDismiss} onPress={() => setPreviewUri(null)} />
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#050b16",
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(109, 214, 255, 0.15)",
  },
  title: {
    color: "#f5f7fb",
    fontSize: 20,
    fontWeight: "800",
  },
  subtitle: {
    color: "#7f96b6",
    fontSize: 12,
    marginTop: 4,
  },
  list: {
    padding: 20,
    gap: 12,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 40,
    gap: 6,
  },
  emptyTitle: {
    color: "#f5f7fb",
    fontSize: 16,
    fontWeight: "700",
  },
  emptySubtitle: {
    color: "#7f96b6",
    fontSize: 12,
  },
  userBubble: {
    backgroundColor: "rgba(109, 214, 255, 0.15)",
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignSelf: "flex-end",
    maxWidth: "85%",
    borderWidth: 1,
    borderColor: "rgba(109, 214, 255, 0.35)",
  },
  assistantBubble: {
    backgroundColor: "rgba(10, 31, 68, 0.8)",
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignSelf: "flex-start",
    maxWidth: "85%",
    borderWidth: 1,
    borderColor: "rgba(109, 214, 255, 0.18)",
  },
  roleLabel: {
    color: "#9fb0c8",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  messageText: {
    color: "#f5f7fb",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
  },
  attachmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
  },
  attachmentChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(109, 214, 255, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(109, 214, 255, 0.3)",
  },
  attachmentText: {
    color: "#bfe9ff",
    fontSize: 12,
    fontWeight: "600",
  },
  previewBackdrop: {
    flex: 1,
    backgroundColor: "rgba(5, 11, 22, 0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    gap: 16,
  },
  previewDismiss: {
    height: 1,
    width: "100%",
  },
  previewCard: {
    width: "100%",
    maxHeight: "75%",
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(109, 214, 255, 0.25)",
    backgroundColor: "#0a1f44",
  },
  previewImage: {
    width: "100%",
    height: "100%",
    resizeMode: "contain",
  },
});
