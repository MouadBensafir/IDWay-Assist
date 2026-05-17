import { useCallback } from "react";
import type { SelectionModalProps } from "./SelectionModal";

export function useSelectionModalLogic(props: SelectionModalProps) {
  const { onSelect } = props;

  const getOptionPressHandler = useCallback(
    (key: string) => () => onSelect(key),
    [onSelect]
  );

  return {
    ...props,
    getOptionPressHandler,
  };
}
