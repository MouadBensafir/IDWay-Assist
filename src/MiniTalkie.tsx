import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMiniTalkieLogic, type Status } from "./MiniTalkie.logic";
import SelectionModal from "./components/SelectionModal";

const ASSISTANT_CARD_HEIGHT = 150;
const BOTTOM_ACTIONS_HEIGHT = 100;
const BOTTOM_ACTIONS_OFFSET = 16;
const COLLECTED_OFFSET = BOTTOM_ACTIONS_HEIGHT + BOTTOM_ACTIONS_OFFSET + 8;

export default function MiniTalkie() {
  const {
    activeSelector,
    attachments,
    barScales,
    collectedDataText,
    displayReply,
    errorMessage,
    fadeAnim,
    isMicMuted,
    languageLabel,
    languageOptions,
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
    tokenUsageText,
    uploadBusy,
    voiceLabel,
    voiceOptions,
    voiceSelectorDisabled,
    selectedLanguage,
    selectedVoiceId,
    getRemoveAttachmentHandler,
    toggleMicMute,
  } = useMiniTalkieLogic();

  const [collectedOpen, setCollectedOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setElapsedSeconds(0);
      return;
    }
    const timer = setInterval(() => {
      setElapsedSeconds((current) => current + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionId]);

  const callStatus = getCallStatus(status);
  const waveStyle = getWaveStyle(status);
  const elapsedLabel = formatElapsed(elapsedSeconds);
  const collectedEntries = useMemo(
    () => parseCollectedEntries(collectedDataText),
    [collectedDataText]
  );
  const collectedCount = collectedEntries.length;
  const hasCollectedData = collectedCount > 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.container}>
          <View style={styles.callHeader}>
            <Text style={styles.callEyebrow}>INGROUPE</Text>
            <Text style={styles.callTitle}>Assistant</Text>
            <Text style={styles.callStatus}>{callStatus}</Text>
            <Text style={styles.callTimer}>{elapsedLabel}</Text>
          </View>

          <View style={styles.avatarRing}>
            <MaterialCommunityIcons name="robot-happy-outline" size={42} color="#6dd6ff" />
          </View>

          <View style={styles.waveCard}>
            <View style={styles.waveRow}>
              {barScales.map((bar, index) => (
                <Animated.View
                  key={`wave-${index}`}
                  style={[
                    styles.waveBar,
                    waveStyle,
                    { transform: [{ scaleY: bar }] },
                  ]}
                />
              ))}
            </View>
          </View>

          <View style={styles.assistantCard}>
            {displayReply ? (
              <>
                <Text style={styles.assistantLabel}>Assistant</Text>
                <ScrollView
                  style={styles.assistantScroll}
                  contentContainerStyle={styles.assistantScrollContent}
                  showsVerticalScrollIndicator={false}
                >
                  <Animated.Text style={[styles.assistantText, { opacity: fadeAnim }]}>
                    {panelText}
                  </Animated.Text>
                </ScrollView>
              </>
            ) : (
              <>
                <Text style={styles.userLabel}>You</Text>
                <ScrollView
                  style={styles.assistantScroll}
                  contentContainerStyle={styles.assistantScrollContent}
                  showsVerticalScrollIndicator={false}
                >
                  <Text style={styles.userText}>{panelText}</Text>
                </ScrollView>
              </>
            )}
          </View>

          {attachments.length ? (
            <View style={styles.attachmentRow}>
              {attachments.map((attachment, index) => (
                <View
                  key={`${attachment.name}-${attachment.uri}`}
                  style={styles.attachmentChip}
                >
                  <Ionicons
                    name={
                      attachment.type?.startsWith("image/")
                        ? "image-outline"
                        : "document-outline"
                    }
                    size={14}
                    color="#6dd6ff"
                  />
                  <Text style={styles.attachmentText} numberOfLines={1}>
                    {attachment.name}
                  </Text>
                  <Pressable
                    style={styles.attachmentRemove}
                    onPress={getRemoveAttachmentHandler(index)}
                  >
                    <Ionicons name="close" size={12} color="#ff9f9f" />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        {hasCollectedData ? (
          <View style={styles.collectedFixed}>
            <Pressable
              onPress={() => setCollectedOpen((current) => !current)}
              style={[
                styles.collectedToggle,
                collectedOpen ? styles.collectedToggleOpen : null,
              ]}
            >
              <Text style={styles.collectedTitle}>Collected so far</Text>
              <View style={styles.collectedMeta}>
                <View style={styles.collectedBadge}>
                  <Text style={styles.collectedBadgeText}>{collectedCount}</Text>
                </View>
                <Ionicons
                  name="chevron-down"
                  size={16}
                  color="rgba(255,255,255,0.35)"
                  style={collectedOpen ? styles.collectedChevronOpen : null}
                />
              </View>
            </Pressable>
            {collectedOpen ? (
              <View style={styles.collectedBody}>
                {collectedEntries.map((entry, index) => (
                  <View
                    key={`${entry.key}-${index}`}
                    style={[
                      styles.collectedRow,
                      index === collectedEntries.length - 1
                        ? styles.collectedRowLast
                        : null,
                    ]}
                  >
                    <Text style={styles.collectedKey}>{entry.key}</Text>
                    <Text style={styles.collectedValue}>{entry.value}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.actionRowFixed}>
          <Pressable style={styles.actionButton} onPress={toggleMicMute}>
            <View
              style={[
                styles.actionIcon,
                isMicMuted ? styles.actionIconMuted : styles.actionIconDefault,
              ]}
            >
              <Ionicons
                name={isMicMuted ? "mic-off-outline" : "mic-outline"}
                size={26}
                color={isMicMuted ? "#ff6b6b" : "#ffffff"}
              />
            </View>
            <Text style={styles.actionLabel}>
              {isMicMuted ? "Unmute" : "Hold"}
            </Text>
          </Pressable>
          <Pressable style={styles.actionButton} onPress={pickFiles}>
            <View style={[styles.actionIcon, styles.actionIconDefault]}>
              <Ionicons name="attach-outline" size={26} color="#ffffff" />
            </View>
            <Text style={styles.actionLabel}>Document</Text>
          </Pressable>
          <Pressable style={styles.actionButton} onPress={takePhoto}>
            <View style={[styles.actionIcon, styles.actionIconDefault]}>
              <Ionicons name="camera-outline" size={26} color="#ffffff" />
            </View>
            <Text style={styles.actionLabel}>Photo</Text>
          </Pressable>
          <Pressable
            style={styles.actionButton}
            onPress={resetConversation}
            disabled={!sessionId}
          >
            <View
              style={[
                styles.actionIcon,
                styles.actionIconEnd,
                !sessionId ? styles.actionIconEndDisabled : null,
              ]}
            >
              <Ionicons
                name="call-outline"
                size={26}
                color="#ffffff"
                style={styles.endCallIcon}
              />
            </View>
            <Text style={styles.endCallLabel}>End call</Text>
          </Pressable>
        </View>
      </View>

      <SelectionModal
        title="Choose language"
        visible={activeSelector === "language"}
        options={languageOptions}
        selectedKey={selectedLanguage}
        onClose={closeSelector}
        onSelect={handleLanguageSelect}
      />

      <SelectionModal
        title="Choose voice"
        visible={activeSelector === "voice"}
        options={voiceOptions}
        selectedKey={selectedVoiceId}
        onClose={closeSelector}
        onSelect={handleVoiceSelect}
      />
    </SafeAreaView>
  );
}

function getWaveStyle(status: Status) {
  switch (status) {
    case "listening":
      return styles.waveListening;
    case "processing":
      return styles.waveProcessing;
    case "speaking":
      return styles.waveSpeaking;
    case "error":
      return styles.waveError;
    case "ready":
      return styles.waveReady;
    case "checking":
    default:
      return styles.waveChecking;
  }
}

function getCallStatus(status: Status) {
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
    default:
      return "Something went wrong";
  }
}

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return `${mm}:${ss}`;
}

function parseCollectedEntries(text: string) {
  if (!text) {
    return [] as { key: string; value: string }[];
  }

  return text
    .split("\n")
    .map((line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) {
        return null;
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (!key || !value) {
        return null;
      }
      return { key, value };
    })
    .filter((entry): entry is { key: string; value: string } => Boolean(entry));
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#0a1533",
  },
  screen: {
    flex: 1,
  },
  container: {
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 18,
    flex: 1,
    paddingBottom: COLLECTED_OFFSET + BOTTOM_ACTIONS_HEIGHT,
  },
  callHeader: {
    alignItems: "center",
    gap: 4,
  },
  callEyebrow: {
    fontSize: 11,
    color: "rgba(255,255,255,0.4)",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontWeight: "700",
  },
  callTitle: {
    fontSize: 30,
    fontWeight: "700",
    color: "#ffffff",
    letterSpacing: -0.5,
  },
  callStatus: {
    fontSize: 13,
    color: "#6dd6ff",
    fontWeight: "500",
  },
  callTimer: {
    fontSize: 12,
    color: "rgba(255,255,255,0.35)",
  },
  avatarRing: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: "#1a2f6e",
    borderWidth: 2,
    borderColor: "#2d4fba",
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
  },
  waveCard: {
    height: 52,
    borderRadius: 14,
    backgroundColor: "rgba(5,14,30,0.7)",
    borderWidth: 1,
    borderColor: "rgba(109,214,255,0.15)",
    justifyContent: "center",
    overflow: "hidden",
  },
  waveRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    height: 36,
  },
  waveBar: {
    width: 5,
    height: 32,
    borderRadius: 6,
    backgroundColor: "#6dd6ff",
  },
  waveChecking: {
    backgroundColor: "rgba(109, 214, 255, 0.7)",
  },
  waveReady: {
    backgroundColor: "rgba(109, 214, 255, 0.9)",
  },
  waveListening: {
    backgroundColor: "#6dd6ff",
  },
  waveProcessing: {
    backgroundColor: "#f5c04e",
  },
  waveSpeaking: {
    backgroundColor: "#7ae6c7",
  },
  waveError: {
    backgroundColor: "#ff6b6b",
  },
  assistantCard: {
    height: ASSISTANT_CARD_HEIGHT,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(109,214,255,0.18)",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  assistantLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "#6dd6ff",
    marginBottom: 6,
  },
  assistantText: {
    fontSize: 14,
    color: "#f0f4ff",
    lineHeight: 21,
  },
  assistantScroll: {
    flex: 1,
  },
  assistantScrollContent: {
    paddingBottom: 4,
  },
  userLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.35)",
    marginBottom: 6,
  },
  userText: {
    fontSize: 14,
    color: "rgba(255,255,255,0.55)",
    lineHeight: 21,
  },
  attachmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(109,214,255,0.2)",
    backgroundColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: "100%",
  },
  attachmentText: {
    color: "#c7d6ff",
    fontSize: 11,
    fontWeight: "600",
    maxWidth: 140,
  },
  attachmentRemove: {
    padding: 4,
  },
  collectedFixed: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: COLLECTED_OFFSET,
  },
  collectedToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(26,47,110,0.55)",
    borderWidth: 1,
    borderColor: "rgba(109,214,255,0.18)",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  collectedToggleOpen: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  collectedTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.45)",
  },
  collectedMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  collectedBadge: {
    backgroundColor: "rgba(109,214,255,0.18)",
    borderRadius: 99,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  collectedBadgeText: {
    fontSize: 11,
    color: "#6dd6ff",
    fontWeight: "700",
  },
  collectedChevronOpen: {
    transform: [{ rotate: "180deg" }],
  },
  collectedBody: {
    backgroundColor: "rgba(26,47,110,0.4)",
    borderWidth: 1,
    borderColor: "rgba(109,214,255,0.12)",
    borderTopWidth: 0,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    paddingBottom: 4,
  },
  collectedRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.05)",
  },
  collectedRowLast: {
    borderBottomWidth: 0,
  },
  collectedKey: {
    fontSize: 12,
    color: "rgba(255,255,255,0.45)",
  },
  collectedValue: {
    fontSize: 12,
    color: "#f0f4ff",
    fontWeight: "600",
  },
  actionRowFixed: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: BOTTOM_ACTIONS_OFFSET,
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingHorizontal: 10,
  },
  actionButton: {
    alignItems: "center",
    gap: 7,
  },
  actionIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
  },
  actionIconDefault: {
    backgroundColor: "rgba(255,255,255,0.11)",
  },
  actionIconMuted: {
    backgroundColor: "rgba(224,32,32,0.22)",
  },
  actionIconEnd: {
    backgroundColor: "#c0392b",
  },
  actionIconEndDisabled: {
    opacity: 0.5,
  },
  actionLabel: {
    fontSize: 11,
    color: "rgba(255,255,255,0.55)",
    fontWeight: "500",
  },
  endCallLabel: {
    fontSize: 11,
    color: "#ff9f9f",
    fontWeight: "500",
  },
  endCallIcon: {
    transform: [{ rotate: "135deg" }],
  },
});
