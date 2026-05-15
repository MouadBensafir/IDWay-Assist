import { createContext, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ConversationItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

type ConversationContextValue = {
  history: ConversationItem[];
  addUserMessage: (text: string) => void;
  addAssistantMessage: (text: string) => void;
};

const ConversationContext = createContext<ConversationContextValue | null>(null);

export function ConversationProvider({ children }: { children: ReactNode }) {
  const [history, setHistory] = useState<ConversationItem[]>([]);
  const counterRef = useRef(0);

  const createItem = (role: ConversationItem["role"], text: string) => {
    counterRef.current += 1;
    return {
      id: `${Date.now()}-${counterRef.current}`,
      role,
      text,
      timestamp: Date.now(),
    };
  };

  const addUserMessage = (text: string) => {
    const clean = text.trim();
    if (!clean) {
      return;
    }
    setHistory((current) => [...current, createItem("user", clean)]);
  };

  const addAssistantMessage = (text: string) => {
    const clean = text.trim();
    if (!clean) {
      return;
    }
    setHistory((current) => [...current, createItem("assistant", clean)]);
  };

  const value = useMemo(
    () => ({
      history,
      addUserMessage,
      addAssistantMessage,
    }),
    [history]
  );

  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversationHistory() {
  const context = useContext(ConversationContext);
  if (!context) {
    throw new Error("useConversationHistory must be used within ConversationProvider");
  }
  return context;
}
