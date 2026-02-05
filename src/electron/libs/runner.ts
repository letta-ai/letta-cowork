import {
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
const DEBUG = process.env.DEBUG_RUNNER === "true";

// Simple logger for runner
const log = (msg: string, data?: Record<string, unknown>) => {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] [runner] ${msg}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${timestamp}] [runner] ${msg}`);
  }
};

// Debug-only logging (verbose)
const debug = (msg: string, data?: Record<string, unknown>) => {
  if (!DEBUG) return;
  log(msg, data);
};

// Store active Letta sessions for abort handling
let activeLettaSession: LettaSession | null = null;

// Store agentId for reuse across conversations
let cachedAgentId: string | null = null;

export async function runLetta(options: RunnerOptions): Promise<RunnerHandle> {
  const { prompt, session, resumeConversationId, onEvent, onSessionUpdate } = options;
  
  debug("runLetta called", {
    prompt: prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
    sessionId: session.id,
    resumeConversationId,
    cachedAgentId,
    cwd: session.cwd,
  });

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

      // Validate that resumeConversationId looks like a valid Letta ID
      // Valid IDs are: agent-xxx, conv-xxx, conversation-xxx, or UUIDs
      const isValidLettaId = (id: string | undefined): boolean => {
        if (!id) return false;
        // Check for known prefixes or UUID format
        return /^(agent-|conv-|conversation-|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.test(id);
      };

      if (resumeConversationId && isValidLettaId(resumeConversationId)) {
        // Resume specific conversation
        debug("creating session: resumeSession with conversationId", { resumeConversationId });
        lettaSession = resumeSession(resumeConversationId, sessionOptions);
      } else if (resumeConversationId && !isValidLettaId(resumeConversationId)) {
        // Invalid ID provided - log warning and fall back to cachedAgentId
        log("WARNING: invalid resumeConversationId, falling back", { 
          invalidId: resumeConversationId, 
          fallbackTo: cachedAgentId ? "cachedAgentId" : "createSession" 
        });
        if (cachedAgentId) {
          debug("creating session: resumeSession with cachedAgentId (fallback)", { cachedAgentId });
          lettaSession = resumeSession(cachedAgentId, sessionOptions);
        } else {
          debug("creating session: createSession (new agent, fallback)");
          lettaSession = createSession(sessionOptions);
        }
      } else if (cachedAgentId) {
        // Create new conversation on existing agent
        debug("creating session: resumeSession with cachedAgentId", { cachedAgentId });
        lettaSession = resumeSession(cachedAgentId, sessionOptions);
      } else {
        // First time - create new agent and session
        debug("creating session: createSession (new agent)");
        lettaSession = createSession(sessionOptions);
      }
      debug("session created successfully");

      // Store for abort handling
      activeLettaSession = lettaSession;

      // Send the prompt (triggers init internally)
      debug("calling send()");
      await lettaSession.send(prompt);
      debug("send() completed", {
        conversationId: lettaSession.conversationId,
        agentId: lettaSession.agentId,
      });

      // Now initialized - update sessionId and cache agentId
      if (lettaSession.conversationId) {
        currentSessionId = lettaSession.conversationId;
        debug("session initialized", { conversationId: lettaSession.conversationId, agentId: lettaSession.agentId });
        onSessionUpdate?.({ lettaConversationId: lettaSession.conversationId });
      } else {
        log("WARNING: no conversationId available after send()");
      }

      // Cache agentId for future conversations
      if (lettaSession.agentId && !cachedAgentId) {
        cachedAgentId = lettaSession.agentId;
        debug("cached agentId for future conversations", { agentId: cachedAgentId });
      }

      // Stream messages
      debug("starting stream");
      let messageCount = 0;
      for await (const message of lettaSession.stream()) {
        messageCount++;
        debug("received message", { type: message.type, count: messageCount });
        
        // Send message directly to frontend (no transform needed)
        sendMessage(message);

        // Check for result to update session status
        if (message.type === "result") {
          const status = message.success ? "completed" : "error";
          debug("result received", { success: message.success, status });
          onEvent({
            type: "session.status",
            payload: { sessionId: currentSessionId, status, title: currentSessionId }
          });
        }
      }
      debug("stream ended", { totalMessages: messageCount });

      // Query completed normally
      if (session.status === "running") {
        debug("query completed normally");
        onEvent({
          type: "session.status",
          payload: { sessionId: currentSessionId, status: "completed", title: currentSessionId }
        });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        // Session was aborted, don't treat as error
        debug("session aborted");
        return;
      }
      log("ERROR in runLetta", { 
        error: String(error), 
        name: (error as Error).name,
        stack: (error as Error).stack 
      });
      onEvent({
        type: "session.status",
        payload: { sessionId: currentSessionId, status: "error", title: currentSessionId, error: String(error) }
      });
    } finally {
      debug("runLetta finally block, clearing activeLettaSession");
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
