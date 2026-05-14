import { useCallback, useMemo, useRef, useState } from "react";

export type Attachment = {
  uri: string;
  name: string;
  type: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  files?: Attachment[];
};

type StreamDonePayload = {
  response?: string;
  workflow_session_id?: string;
  workflow_id?: string;
  workflow_title?: string;
  token_usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  required_documents?: string[];
  detail?: string;
};

type SendArgs = {
  text: string;
  attachments: Attachment[];
};

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function useStreamingChat(apiUrl: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [partialAssistantText, setPartialAssistantText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isWaitingFirstToken, setIsWaitingFirstToken] = useState(false);
  const [error, setError] = useState("");

  const [workflowSessionId, setWorkflowSessionId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [workflowTitle, setWorkflowTitle] = useState("");
  const [requiredDocuments, setRequiredDocuments] = useState<string[]>([]);

  const controllerRef = useRef<AbortController | null>(null);

  const abortStream = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsStreaming(false);
    setIsWaitingFirstToken(false);
  }, []);

  const clearPartialAssistant = useCallback(() => {
    setPartialAssistantText("");
  }, []);

  const sendMessage = useCallback(async ({ text, attachments }: SendArgs): Promise<string> => {
    abortStream();
    setError("");
    setPartialAssistantText("");

    const userText = text.trim() || "Please process the attached file(s).";
    const userMessage: ChatMessage = { id: makeId(), role: "user", text: userText, files: attachments };
    setMessages((prev) => [...prev, userMessage]);

    const fd = new FormData();
    fd.append("prompt", userText);
    if (workflowSessionId) {
      fd.append("workflow_session_id", workflowSessionId);
    }
    for (const file of attachments) {
      fd.append("file", { uri: file.uri, name: file.name, type: file.type } as never);
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setIsStreaming(true);
    setIsWaitingFirstToken(true);

    let responseText = "";

    try {
      const res = await fetch(`${apiUrl}/chat/stream`, {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Backend error: ${res.status}`);
      }

      const reader = res.body.getReader();
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
            continue;
          }
          if (!line.startsWith("data: ")) continue;

          const data = JSON.parse(line.slice(6)) as StreamDonePayload & { token?: string };

          if (currentEvent === "token") {
            const token = data.token || "";
            if (token) {
              if (isWaitingFirstToken) setIsWaitingFirstToken(false);
              responseText += token;
              setPartialAssistantText(responseText);
            }
          } else if (currentEvent === "done") {
            if (data.workflow_session_id) setWorkflowSessionId(data.workflow_session_id);
            if (data.workflow_id) setWorkflowId(data.workflow_id);
            if (data.workflow_title) setWorkflowTitle(data.workflow_title);
            if (Array.isArray(data.required_documents)) setRequiredDocuments(data.required_documents);

            const finalText = (data.response || responseText).trim();
            if (finalText) {
              setMessages((prev) => [...prev, { id: makeId(), role: "assistant", text: finalText }]);
            }
            setPartialAssistantText("");
            setIsStreaming(false);
            setIsWaitingFirstToken(false);
            controllerRef.current = null;
            return finalText;
          } else if (currentEvent === "error") {
            throw new Error(data.detail || "Streaming failed.");
          }

          currentEvent = "";
        }
      }

      const partial = responseText.trim();
      if (partial) {
        setMessages((prev) => [...prev, { id: makeId(), role: "assistant", text: partial }]);
      }
      setPartialAssistantText("");
      setIsStreaming(false);
      setIsWaitingFirstToken(false);
      controllerRef.current = null;
      return partial;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return "";
      }
      const partial = responseText.trim();
      if (partial) {
        setMessages((prev) => [...prev, { id: makeId(), role: "assistant", text: partial }]);
      }
      setPartialAssistantText("");
      setIsStreaming(false);
      setIsWaitingFirstToken(false);
      controllerRef.current = null;
      setError(err instanceof Error ? err.message : "Request failed.");
      return partial;
    }
  }, [abortStream, apiUrl, isWaitingFirstToken, workflowSessionId]);

  const resetConversation = useCallback(() => {
    abortStream();
    setMessages([]);
    setPartialAssistantText("");
    setError("");
    setWorkflowSessionId("");
    setWorkflowId("");
    setWorkflowTitle("");
    setRequiredDocuments([]);
  }, [abortStream]);

  return useMemo(() => ({
    messages,
    partialAssistantText,
    isStreaming,
    isWaitingFirstToken,
    error,
    workflowSessionId,
    workflowId,
    workflowTitle,
    requiredDocuments,
    sendMessage,
    abortStream,
    clearPartialAssistant,
    resetConversation,
  }), [
    messages,
    partialAssistantText,
    isStreaming,
    isWaitingFirstToken,
    error,
    workflowSessionId,
    workflowId,
    workflowTitle,
    requiredDocuments,
    sendMessage,
    abortStream,
    clearPartialAssistant,
    resetConversation,
  ]);
}
