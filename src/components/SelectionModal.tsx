import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { SelectionOption } from "../shared.logic";
import { useSelectionModalLogic } from "./SelectionModal.logic";

export type SelectionModalProps = {
  title: string;
  visible: boolean;
  options: SelectionOption[];
  selectedKey: string;
  onClose: () => void;
  onSelect: (key: string) => void;
};

export default function SelectionModal(props: SelectionModalProps) {
  const {
    title,
    visible,
    options,
    selectedKey,
    onClose,
    getOptionPressHandler,
  } =
    useSelectionModalLogic(props);

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
            {options.map((option: SelectionOption) => {
              const selected = option.key === selectedKey;

              return (
                <Pressable
                  key={option.key}
                  onPress={getOptionPressHandler(option.key)}
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

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(5, 11, 22, 0.6)",
    justifyContent: "flex-end",
  },
  modalDismissArea: {
    flex: 1,
  },
  modalCard: {
    maxHeight: "70%",
    backgroundColor: "#0a1f44",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
    gap: 14,
  },
  modalTitle: {
    color: "#f5f7fb",
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
    backgroundColor: "rgba(109, 214, 255, 0.2)",
  },
  modalOptionPressed: {
    opacity: 0.8,
  },
  modalOptionText: {
    color: "#f5f7fb",
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
    backgroundColor: "#6dd6ff",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCloseText: {
    color: "#0a1f44",
    fontSize: 14,
    fontWeight: "800",
  },
});
