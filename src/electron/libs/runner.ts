import {
  createAgent,
  createSession,
  resumeSession,
  type Session as LettaSession,
  type SDKMessage,
  type CanUseToolResponse,
} from "@letta-ai/letta-code-sdk";
import type { ServerEvent } from "../types.js";
import type { PendingPermission } from "./runtime-state.js";

// Simplified session type for runner
export type RunnerSession = {
  id: string;
  title: string;
  status: string;
  cwd?: string;
  pendingPermissions: Map<string, PendingPermission>;
};

export type RunnerOptions = {
  prompt: string;
  session: RunnerSession;
  resumeConversationId?: string;
  onEvent: (event: ServerEvent) => void;
  onSessionUpdate?: (updates: { lettaConversationId?: string }) => void;
};

export type RunnerHandle = {
  abort: () => void;
};

const DEFAULT_CWD = process.cwd();

// Store active Letta sessions for abort handling
let activeLettaSession: LettaSession | null = null;

// Store agentId for reuse across conversations
let cachedAgentId: string | null = null;

export async function runLetta(options: RunnerOptions): Promise<RunnerHandle> {
  const { prompt, session, resumeConversationId, onEvent, onSessionUpdate } = options;

  // Mutable sessionId - starts as session.id, updated when conversationId is available
  let currentSessionId = session.id;

  const sendMessage = (message: SDKMessage) => {
    onEvent({
      type: "stream.message",
      payload: { sessionId: currentSessionId, message }
    });
  };

  const sendPermissionRequest = (toolUseId: string, toolName: string, input: unknown) => {
    onEvent({
      type: "permission.request",
      payload: { sessionId: currentSessionId, toolUseId, toolName, input }
    });
  };

  // Start the query in the background
  (async () => {
    try {
      // Common options for canUseTool
      const canUseTool = async (toolName: string, input: unknown) => {
        // For AskUserQuestion, we need to wait for user response
        if (toolName === "AskUserQuestion") {
          const toolUseId = crypto.randomUUID();
          sendPermissionRequest(toolUseId, toolName, input);
          return new Promise<CanUseToolResponse>((resolve) => {
            session.pendingPermissions.set(toolUseId, {
              toolUseId,
              toolName,
              input,
              resolve: (result) => {
                session.pendingPermissions.delete(toolUseId);
                resolve(result);
              }
            });
          });
        }
        return { behavior: "allow" as const };
      };

      // Session options
      const sessionOptions = {
        cwd: session.cwd ?? DEFAULT_CWD,
        permissionMode: "bypassPermissions" as const,
        canUseTool,
      };

      // Create or resume session
      let lettaSession: LettaSession;

      if (resumeConversationId) {
        // Resume specific conversation
        lettaSession = resumeSession(resumeConversationId, sessionOptions);
      } else if (cachedAgentId) {
        // Create new conversation on existing agent
        lettaSession = createSession(cachedAgentId, sessionOptions);
      } else {
        // First time - create agent, then create conversation
        cachedAgentId = await createAgent();
        lettaSession = createSession(cachedAgentId, sessionOptions);
      }

      // Store for abort handling
      activeLettaSession = lettaSession;

      // Send the prompt (triggers init internally)
      await lettaSession.send(prompt);
      
      // Now initialized - update sessionId and cache agentId
      if (lettaSession.conversationId) {
        currentSessionId = lettaSession.conversationId;
        onSessionUpdate?.({ lettaConversationId: lettaSession.conversationId });
      }
      
      // Cache agentId for future conversations
      if (lettaSession.agentId && !cachedAgentId) {
        cachedAgentId = lettaSession.agentId;
      }

      // Stream messages
      for await (const message of lettaSession.stream()) {
        // Send message directly to frontend (no transform needed)
        sendMessage(message);

        // Check for result to update session status
        if (message.type === "result") {
          const status = message.success ? "completed" : "error";
          onEvent({
            type: "session.status",
            payload: { sessionId: currentSessionId, status, title: currentSessionId }
          });
        }
      }

      // Query completed normally
      if (session.status === "running") {
        onEvent({
          type: "session.status",
          payload: { sessionId: currentSessionId, status: "completed", title: currentSessionId }
        });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        // Session was aborted, don't treat as error
        return;
      }
      onEvent({
        type: "session.status",
        payload: { sessionId: session.id, status: "error", title: session.title, error: String(error) }
      });
    } finally {
      activeLettaSession = null;
    }
  })();

  return {
    abort: async () => {
      if (activeLettaSession) {
        await activeLettaSession.abort();
      }
    }
  };
}
