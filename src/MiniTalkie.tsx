import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMiniTalkieLogic, type Status } from "./MiniTalkie.logic";
import SelectionModal from "./components/SelectionModal";
import SelectorField from "./components/SelectorField";

export default function MiniTalkie() {
  const {
    activeSelector,
    attachments,
    barScales,
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

  const waveStyle = getWaveStyle(status);

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
              onPress={openLanguageSelector}
            />
            <SelectorField
              label="Voice"
              value={voiceLabel}
              disabled={voiceSelectorDisabled}
              onPress={openVoiceSelector}
            />
            <View style={styles.callActions}>
              <Pressable
                accessibilityRole="button"
                onPress={toggleMicMute}
                style={({ pressed }) => [
                  styles.muteButton,
                  isMicMuted ? styles.muteButtonActive : null,
                  pressed ? styles.muteButtonPressed : null,
                ]}
              >
                <Text style={styles.muteButtonText}>{micToggleLabel}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!sessionId}
                onPress={resetConversation}
                style={({ pressed }) => [
                  styles.endCallButton,
                  !sessionId ? styles.resetButtonDisabled : null,
                  pressed && sessionId ? styles.endCallButtonPressed : null,
                ]}
              >
                <Text style={styles.endCallButtonText}>End Call</Text>
              </Pressable>
            </View>
            <View style={styles.metaPanel}>
              <Text style={styles.metaLabel}>Session</Text>
              <Text style={styles.metaValue}>
                {sessionId.trim() || "No active session"}
              </Text>
              <Text style={styles.metaLabel}>Tokens Used</Text>
              <Text style={styles.metaValue}>{tokenUsageText}</Text>
              <Text style={styles.metaLabel}>Latency</Text>
              <Text style={styles.metaValue}>{latencyText}</Text>
            </View>
            <View style={styles.uploadActions}>
              <Pressable
                accessibilityRole="button"
                onPress={takePhoto}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed ? styles.secondaryButtonPressed : null,
                ]}
              >
                <Text style={styles.secondaryButtonText}>Take Photo</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={pickFiles}
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
              onPress={sendAttachments}
              style={({ pressed }) => [
                styles.uploadSendButton,
                !attachments.length || uploadBusy ? styles.resetButtonDisabled : null,
                pressed && attachments.length && !uploadBusy
                  ? styles.resetButtonPressed
                  : null,
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
                    onPress={getRemoveAttachmentHandler(index)}
                    style={({ pressed }) => [
                      styles.attachmentChip,
                      pressed ? styles.attachmentChipPressed : null,
                    ]}
                  >
                    <Text style={styles.attachmentChipText}>
                      {attachment.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
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

          <View style={styles.transcriptCard}>
            <Text style={styles.sectionLabel}>{panelLabel}</Text>
            <ScrollView
              style={styles.panelScroll}
              contentContainerStyle={styles.panelScrollContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator={displayReply}
            >
              {displayReply ? (
                <Animated.Text style={[styles.replyText, { opacity: fadeAnim }]}
                >
                  {panelText}
                </Animated.Text>
              ) : (
                <Text style={styles.transcriptText}>{panelText}</Text>
              )}
            </ScrollView>
          </View>

          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

          {status === "error" ? (
            <Pressable
              accessibilityRole="button"
              onPress={retryListening}
              style={({ pressed }) => [
                styles.retryButton,
                pressed ? styles.retryButtonPressed : null,
              ]}
            >
              <Text style={styles.retryButtonText}>Try Again</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>

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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#050b16",
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 32,
  },
  container: {
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 18,
    flexGrow: 1,
  },
  controlsCard: {
    padding: 18,
    borderRadius: 22,
    backgroundColor: "#0a1f44",
    borderWidth: 1,
    borderColor: "rgba(109, 214, 255, 0.15)",
    gap: 12,
  },
  transcriptCard: {
    minHeight: 220,
    padding: 20,
    borderRadius: 22,
    backgroundColor: "#0a1f44",
    borderWidth: 1,
    borderColor: "rgba(109, 214, 255, 0.2)",
    gap: 12,
  },
  waveCard: {
    height: 72,
    borderRadius: 16,
    backgroundColor: "rgba(5, 14, 30, 0.7)",
    borderWidth: 1,
    borderColor: "rgba(109, 214, 255, 0.15)",
    justifyContent: "center",
    overflow: "hidden",
  },
  waveRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    height: 46,
  },
  waveBar: {
    width: 6,
    height: 36,
    borderRadius: 8,
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
  panelScroll: {
    flex: 1,
  },
  panelScrollContent: {
    paddingBottom: 4,
  },
  sectionLabel: {
    color: "#9fb0c8",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.1,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  transcriptText: {
    color: "#f5f7fb",
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "500",
  },
  replyText: {
    color: "#f5f7fb",
    fontSize: 16,
    lineHeight: 23,
    fontWeight: "500",
  },
  errorText: {
    color: "#ff6b6b",
    fontSize: 14,
    lineHeight: 20,
  },
  resetButton: {
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(197, 203, 213, 0.3)",
    backgroundColor: "rgba(109, 214, 255, 0.1)",
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
    color: "#bfe9ff",
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  metaPanel: {
    gap: 4,
    borderWidth: 1,
    borderColor: "rgba(197, 203, 213, 0.2)",
    borderRadius: 16,
    backgroundColor: "rgba(5, 14, 30, 0.6)",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  metaLabel: {
    color: "#8ea6c3",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 2,
  },
  metaValue: {
    color: "#f5f7fb",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  uploadActions: {
    flexDirection: "row",
    gap: 10,
  },
  callActions: {
    flexDirection: "row",
    gap: 10,
  },
  muteButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(197, 203, 213, 0.3)",
    backgroundColor: "rgba(5, 14, 30, 0.6)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  muteButtonActive: {
    borderColor: "rgba(255, 107, 107, 0.65)",
    backgroundColor: "rgba(255, 107, 107, 0.18)",
  },
  muteButtonPressed: {
    transform: [{ scale: 0.99 }],
  },
  muteButtonText: {
    color: "#bfe9ff",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  endCallButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255, 107, 107, 0.7)",
    backgroundColor: "rgba(255, 107, 107, 0.24)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  endCallButtonPressed: {
    transform: [{ scale: 0.98 }],
  },
  endCallButtonText: {
    color: "#ffd3d3",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(197, 203, 213, 0.3)",
    backgroundColor: "rgba(5, 14, 30, 0.6)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  secondaryButtonPressed: {
    transform: [{ scale: 0.99 }],
  },
  secondaryButtonText: {
    color: "#bfe9ff",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  uploadSendButton: {
    minHeight: 42,
    borderRadius: 14,
    backgroundColor: "#6dd6ff",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  uploadSendButtonText: {
    color: "#0a1f44",
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
    backgroundColor: "rgba(109, 214, 255, 0.15)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  attachmentChipPressed: {
    opacity: 0.8,
  },
  attachmentChipText: {
    color: "#bfe9ff",
    fontSize: 12,
    fontWeight: "700",
  },
  retryButton: {
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 107, 107, 0.4)",
    backgroundColor: "rgba(255, 107, 107, 0.12)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  retryButtonPressed: {
    transform: [{ scale: 0.99 }],
  },
  retryButtonText: {
    color: "#ffb3b3",
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
