import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useConversationHistory } from "./context/ConversationContext";

export default function ConversationScreen() {
  const { history } = useConversationHistory();

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
                    <View key={`${item.id}-${attachment.name}`} style={styles.attachmentChip}>
                      <Text style={styles.attachmentText}>{attachment.name}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>
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
});
