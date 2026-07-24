import { useEffect, useRef, useState } from "react";
import type {
  CanUseToolResponse,
  SDKMessage,
  SDKToolCallMessage,
  SDKToolResultMessage,
  SDKReasoningMessage,
  SDKInitMessage,
  SDKAssistantMessage,
  StreamMessage,
} from "../types";
import type { PermissionRequest } from "../store/useAppStore";
import MDContent from "../render/markdown";
import { DecisionPanel } from "./DecisionPanel";

type ToolStatus = "pending" | "success" | "error";
const toolStatusMap = new Map<string, ToolStatus>();
const toolStatusListeners = new Set<() => void>();
const MAX_VISIBLE_LINES = 3;

type AskUserQuestionInput = {
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

const getAskUserQuestionSignature = (input?: AskUserQuestionInput | null) => {
  if (!input?.questions?.length) return "";
  return input.questions.map((question) => {
    const options = (question.options ?? []).map((o) => `${o.label}|${o.description ?? ""}`).join(",");
    return `${question.question}|${question.header ?? ""}|${question.multiSelect ? "1" : "0"}|${options}`;
  }).join("||");
};

const setToolStatus = (toolCallId: string | undefined, status: ToolStatus) => {
  if (!toolCallId) return;
  toolStatusMap.set(toolCallId, status);
  toolStatusListeners.forEach((listener) => listener());
};

const useToolStatus = (toolCallId: string | undefined) => {
  const [status, setStatus] = useState<ToolStatus | undefined>(() =>
    toolCallId ? toolStatusMap.get(toolCallId) : undefined
  );
  useEffect(() => {
    if (!toolCallId) return;
    const handleUpdate = () => setStatus(toolStatusMap.get(toolCallId));
    toolStatusListeners.add(handleUpdate);
    return () => { toolStatusListeners.delete(handleUpdate); };
  }, [toolCallId]);
  return status;
};

const StatusDot = ({ variant = "accent", isActive = false, isVisible = true }: {
  variant?: "accent" | "success" | "error"; isActive?: boolean; isVisible?: boolean;
}) => {
  if (!isVisible) return null;
  const colorClass = variant === "success" ? "bg-success" : variant === "error" ? "bg-error" : "bg-accent";
  return (
    <span className="relative flex h-2 w-2">
      {isActive && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${colorClass} opacity-75`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${colorClass}`} />
    </span>
  );
};



export function isMarkdown(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const patterns: RegExp[] = [/^#{1,6}\s+/m, /```[\s\S]*?```/];
  return patterns.some((pattern) => pattern.test(text));
}

function extractTagContent(input: string, tag: string): string | null {
  const match = input.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

// Tool Result Card (for tool_result messages)
const ToolResultCard = ({ message }: { message: SDKToolResultMessage }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const isFirstRender = useRef(true);
  
  const isError = message.isError;
  let lines: string[];
  
  if (isError) {
    lines = [extractTagContent(message.content, "tool_use_error") || message.content];
  } else {
    lines = message.content.split("\n");
  }

  const isMarkdownContent = isMarkdown(lines.join("\n"));
  const hasMoreLines = lines.length > MAX_VISIBLE_LINES;
  const visibleContent = hasMoreLines && !isExpanded ? lines.slice(0, MAX_VISIBLE_LINES).join("\n") : lines.join("\n");

  useEffect(() => { setToolStatus(message.toolCallId, isError ? "error" : "success"); }, [message.toolCallId, isError]);
  useEffect(() => {
    if (!hasMoreLines || isFirstRender.current) { isFirstRender.current = false; return; }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hasMoreLines, isExpanded]);

  return (
    <div className="flex flex-col mt-4">
      <div className="header text-accent">Output</div>
      <div className="mt-2 rounded-xl bg-surface-tertiary p-3">
        <pre className={`text-sm whitespace-pre-wrap break-words font-mono ${isError ? "text-red-500" : "text-ink-700"}`}>
          {isMarkdownContent ? <MDContent text={visibleContent} /> : visibleContent}
        </pre>
        {hasMoreLines && (
          <button onClick={() => setIsExpanded(!isExpanded)} className="mt-2 text-sm text-accent hover:text-accent-hover transition-colors flex items-center gap-1">
            <span>{isExpanded ? "▲" : "▼"}</span>
            <span>{isExpanded ? "Collapse" : `Show ${lines.length - MAX_VISIBLE_LINES} more lines`}</span>
          </button>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

// Assistant Message Card
const AssistantCard = ({ message, showIndicator = false }: { message: SDKAssistantMessage; showIndicator?: boolean }) => (
  <div className="flex flex-col mt-4">
    <div className="header text-accent flex items-center gap-2">
      <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
      Assistant
    </div>
    <MDContent text={message.content} />
  </div>
);

// Reasoning Card
const ReasoningCard = ({ message, showIndicator = false }: { message: SDKReasoningMessage; showIndicator?: boolean }) => (
  <div className="flex flex-col mt-4">
    <div className="header text-accent flex items-center gap-2">
      <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
      Thinking
    </div>
    <MDContent text={message.content} />
  </div>
);

// Tool Call Card
const ToolCallCard = ({ 
  message, 
  showIndicator = false,
  permissionRequest,
  onPermissionResult
}: { 
  message: SDKToolCallMessage; 
  showIndicator?: boolean;
  permissionRequest?: PermissionRequest;
  onPermissionResult?: (toolUseId: string, result: CanUseToolResponse) => void;
}) => {
  const toolStatus = useToolStatus(message.toolCallId);
  const statusVariant = toolStatus === "error" ? "error" : "success";
  const isPending = !toolStatus || toolStatus === "pending";
  const shouldShowDot = toolStatus === "success" || toolStatus === "error" || showIndicator;

  useEffect(() => {
    if (message.toolCallId && !toolStatusMap.has(message.toolCallId)) {
      setToolStatus(message.toolCallId, "pending");
    }
  }, [message.toolCallId]);

  const getToolInfo = (): string | null => {
    const input = message.toolInput;
    switch (message.toolName) {
      case "Bash": return (input as any)?.command || null;
      case "Read": case "Write": case "Edit": return (input as any)?.file_path || null;
      case "Glob": case "Grep": return (input as any)?.pattern || null;
      case "Task": return (input as any)?.description || null;
      case "WebFetch": return (input as any)?.url || null;
      default: return null;
    }
  };

  // Handle AskUserQuestion specially
  if (message.toolName === "AskUserQuestion") {
    const input = message.toolInput as AskUserQuestionInput | null;
    const questions = input?.questions ?? [];
    const currentSignature = getAskUserQuestionSignature(input);
    const requestSignature = getAskUserQuestionSignature(permissionRequest?.input as AskUserQuestionInput | undefined);
    const isActiveRequest = permissionRequest && currentSignature === requestSignature;

    if (isActiveRequest && onPermissionResult) {
      return (
        <div className="mt-4">
          <DecisionPanel
            request={permissionRequest}
            onSubmit={(result) => onPermissionResult(permissionRequest.toolUseId, result)}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-2 rounded-[1rem] bg-surface-tertiary px-3 py-2 mt-4">
        <div className="flex flex-row items-center gap-2">
          <StatusDot variant="success" isActive={false} isVisible={true} />
          <span className="inline-flex items-center rounded-md text-accent py-0.5 text-sm font-medium">AskUserQuestion</span>
        </div>
        {questions.map((q, idx) => (
          <div key={idx} className="text-sm text-ink-700 ml-4">{q.question}</div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-[1rem] bg-surface-tertiary px-3 py-2 mt-4 overflow-hidden">
      <div className="flex flex-row items-center gap-2 min-w-0">
        <StatusDot variant={statusVariant} isActive={isPending && showIndicator} isVisible={shouldShowDot} />
        <div className="flex flex-row items-center gap-2 tool-use-item min-w-0 flex-1">
          <span className="inline-flex items-center rounded-md text-accent py-0.5 text-sm font-medium shrink-0">{message.toolName}</span>
          <span className="text-sm text-muted truncate">{getToolInfo()}</span>
        </div>
      </div>
    </div>
  );
};

// Init Card
const InitCard = ({ message, showIndicator = false }: { message: SDKInitMessage; showIndicator?: boolean }) => {
  const InfoItem = ({ name, value }: { name: string; value: string }) => (
    <div className="text-[14px]">
      <span className="mr-4 font-normal">{name}</span>
      <span className="font-light">{value}</span>
    </div>
  );
  
  return (
    <div className="flex flex-col gap-2 mt-2">
      <div className="header text-accent flex items-center gap-2">
        <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
        Session Started
      </div>
      <div className="flex flex-col rounded-xl px-4 py-2 border border-ink-900/10 bg-surface-secondary space-y-1">
        <InfoItem name="Conversation ID" value={message.conversationId || "-"} />
        <InfoItem name="Model" value={message.model || "-"} />
      </div>
    </div>
  );
};

// User Prompt Card
const UserPromptCard = ({ message, showIndicator = false }: { message: { type: "user_prompt"; prompt: string }; showIndicator?: boolean }) => (
  <div className="flex flex-col mt-4">
    <div className="header text-accent flex items-center gap-2">
      <StatusDot variant="success" isActive={showIndicator} isVisible={showIndicator} />
      User
    </div>
    <MDContent text={message.prompt} />
  </div>
);

export function MessageCard({
  message,
  isLast = false,
  isRunning = false,
  permissionRequest,
  onPermissionResult
}: {
  message: StreamMessage;
  isLast?: boolean;
  isRunning?: boolean;
  permissionRequest?: PermissionRequest;
  onPermissionResult?: (toolUseId: string, result: CanUseToolResponse) => void;
}) {
  const showIndicator = isLast && isRunning;

  // User prompt (local type, not from SDK)
  if (message.type === "user_prompt") {
    return <UserPromptCard message={message} showIndicator={showIndicator} />;
  }

  // SDK message types
  const sdkMessage = message as SDKMessage;

  switch (sdkMessage.type) {
    case "init":
      return <InitCard message={sdkMessage} showIndicator={showIndicator} />;
    
    case "assistant":
      return <AssistantCard message={sdkMessage} showIndicator={showIndicator} />;
    
    case "reasoning":
      return <ReasoningCard message={sdkMessage} showIndicator={showIndicator} />;
    
    case "tool_call":
      return <ToolCallCard message={sdkMessage} showIndicator={showIndicator} permissionRequest={permissionRequest} onPermissionResult={onPermissionResult} />;
    
    case "tool_result":
      return <ToolResultCard message={sdkMessage} />;
    
    case "error":
      return (
        <div className="flex flex-col gap-2 mt-4">
          <div className="header text-error">Error</div>
          <div className="rounded-xl bg-error-light p-3">
            <pre className="text-sm text-error whitespace-pre-wrap">{sdkMessage.message}</pre>
          </div>
        </div>
      );

    case "result":
      // Don't render session result
      if (sdkMessage.success) {
        return null;
      }
      // Only show errors
      return (
        <div className="flex flex-col gap-2 mt-4">
          <div className="header text-error">Error</div>
          <div className="rounded-xl bg-error-light p-3">
            <pre className="text-sm text-error whitespace-pre-wrap">{sdkMessage.error || "Unknown error"}</pre>
          </div>
        </div>
      );
    
    default:
      return null;
  }
}

export { MessageCard as EventCard };
