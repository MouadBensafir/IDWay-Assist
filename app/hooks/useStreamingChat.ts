import { useCallback, useRef, useState } from "react";

export type StreamAttachment = {
  uri: string;
  name: string;
  type: string;
};

export type StreamingDonePayload = {
  response?: string;
  workflow_session_id?: string;
  session_id?: string;
  token_usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
};

type SendMessageInput = {
  apiUrl: string;
  workflowId: string;
  prompt: string;
  workflowSessionId?: string;
  attachments?: StreamAttachment[];
  onChunk?: (chunk: string) => void;
};

type UseStreamingChatState = {
  isStreaming: boolean;
  waitingFirstToken: boolean;
  partialText: string;
  error: string;
};

export function useStreamingChat() {
  const [state, setState] = useState<UseStreamingChatState>({
    isStreaming: false,
    waitingFirstToken: false,
    partialText: "",
    error: "",
  });

  const abortRef = useRef<AbortController | null>(null);

  const abortStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((current) => ({
      ...current,
      isStreaming: false,
      waitingFirstToken: false,
      partialText: "",
    }));
  }, []);

  const sendMessage = useCallback(async (input: SendMessageInput) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let buffer = "";
    let assembled = "";
    let donePayload: StreamingDonePayload | null = null;

    setState({ isStreaming: true, waitingFirstToken: true, partialText: "", error: "" });

    const body = new FormData();
    body.append("prompt", input.prompt);
    if (input.workflowSessionId?.trim()) {
      body.append("workflow_session_id", input.workflowSessionId.trim());
    }

    for (const file of input.attachments ?? []) {
      body.append("file", {
        uri: file.uri,
        name: file.name,
        type: file.type,
      } as never);
    }

    try {
      const response = await fetch(
        `${input.apiUrl}/workflows/${encodeURIComponent(input.workflowId)}/chat/stream`,
        {
          method: "POST",
          body,
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        }
      );

      if (!response.ok || !response.body) {
        throw new Error(`Streaming request failed (${response.status}).`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          const event = lines.find((line) => line.startsWith("event:"))?.replace("event:", "").trim();
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace("data:", "").trim())
            .join("\n");

          if (!data) {
            continue;
          }

          if (event === "delta") {
            const parsed = JSON.parse(data) as { text?: string };
            const chunk = parsed.text ?? "";
            if (chunk) {
              assembled += chunk;
              setState((current) => ({
                ...current,
                waitingFirstToken: false,
                partialText: assembled,
              }));
              input.onChunk?.(chunk);
            }
            continue;
          }

          if (event === "done") {
            donePayload = JSON.parse(data) as StreamingDonePayload;
            continue;
          }

          if (event === "error") {
            const parsed = JSON.parse(data) as { detail?: string };
            throw new Error(parsed.detail || "Streaming failed.");
          }
        }
      }

      setState((current) => ({ ...current, isStreaming: false, waitingFirstToken: false }));
      return {
        text: (donePayload?.response as string | undefined) || assembled,
        payload: donePayload,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { text: "", payload: null };
      }
      const message = error instanceof Error ? error.message : "Network error while streaming.";
      setState((current) => ({
        ...current,
        isStreaming: false,
        waitingFirstToken: false,
        error: message,
      }));
      return { text: assembled, payload: donePayload };
    }
  }, []);

  return {
    ...state,
    sendMessage,
    abortStream,
    clearError: () => setState((current) => ({ ...current, error: "" })),
    clearPartial: () => setState((current) => ({ ...current, partialText: "" })),
  };
}
