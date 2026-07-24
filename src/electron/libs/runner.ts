import {
  LettaAgentClient,
  type LettaCodeClientOptions,
  type LettaCodeSession,
  type SDKMessage,
  type CanUseToolResponse,
} from "@letta-ai/letta-agent-sdk";
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

/**
 * Resolve the SDK backend from environment variables:
 *
 * - LETTA_BACKEND=local  -> fully local runtime (agents stored on this machine)
 * - LETTA_BACKEND=cloud  -> agents stored in Letta Cloud, tools run locally
 *                           (requires LETTA_API_KEY)
 * - LETTA_BACKEND=remote -> connect to a self-hosted app server
 *                           (requires LETTA_SERVER_URL, e.g. ws://127.0.0.1:4500;
 *                           optional LETTA_SERVER_TOKEN)
 *
 * If LETTA_BACKEND is unset: cloud when LETTA_API_KEY is set, local otherwise.
 */
function resolveClientOptions(): LettaCodeClientOptions {
  const backend = (process.env.LETTA_BACKEND ?? "").toLowerCase();

  if (backend === "remote") {
    const url = process.env.LETTA_SERVER_URL;
    if (!url) {
      throw new Error(
        "LETTA_BACKEND=remote requires LETTA_SERVER_URL (e.g. ws://127.0.0.1:4500)"
      );
    }
    const token = process.env.LETTA_SERVER_TOKEN;
    return {
      backend: "remote",
      url,
      ...(token ? { authToken: token } : {}),
    };
  }

  // Cloud mode requires the harness to be authenticated - either via
  // LETTA_API_KEY or a previous `letta login` (the harness reports a clear
  // error if neither is present).
  const useCloudAgents =
    backend === "cloud" || (backend !== "local" && !!process.env.LETTA_API_KEY);
  return {
    backend: "local",
    appServer: { harnessBackend: useCloudAgents ? "api" : "local" },
  };
}

let client: LettaAgentClient | null = null;

function getClient(): LettaAgentClient {
  if (!client) {
    const options = resolveClientOptions();
    debug("creating LettaAgentClient", { options: options as unknown as Record<string, unknown> });
    client = new LettaAgentClient(options);
  }
  return client;
}

// Store active Letta sessions for abort handling
let activeLettaSession: LettaCodeSession | null = null;

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
    let lettaSession: LettaCodeSession | null = null;
    try {
      // Common options for canUseTool
      const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
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
        permissionMode: "unrestricted" as const,
        canUseTool,
      };

      // Validate that resumeConversationId looks like a valid Letta ID
      // Valid IDs are: agent-xxx, conv-xxx, conversation-xxx, local-conv-xxx, or UUIDs
      const isValidLettaId = (id: string | undefined): boolean => {
        if (!id) return false;
        // Check for known prefixes or UUID format
        return /^(agent-|conv-|conversation-|local-conv-|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.test(id);
      };

      const lettaClient = getClient();

      // Workaround for a harness race: enabling memfs during createAgent() runs
      // concurrent `git config` calls that collide on .git/config.lock. Create
      // the agent without memfs, then enable it before the first turn.
      let newAgentId: string | null = null;
      const createAgentWithoutMemfs = async (): Promise<string> => {
        const agentId = await lettaClient.createAgent({
          cwd: sessionOptions.cwd,
          memfs: false,
        });
        newAgentId = agentId;
        return agentId;
      };
      const enableMemfs = async (agentId: string, target: LettaCodeSession) => {
        const response = await target.sendCommand(
          { type: "enable_memfs", agent_id: agentId },
          { responseType: "enable_memfs_response", timeoutMs: 180000 }
        );
        if ((response as { success?: boolean }).success === false) {
          log("WARNING: enable_memfs failed", { response: response as Record<string, unknown> });
        }
      };

      if (resumeConversationId && isValidLettaId(resumeConversationId)) {
        // Resume specific conversation
        debug("creating session: resumeSession with conversationId", { resumeConversationId });
        lettaSession = lettaClient.resumeSession(resumeConversationId, sessionOptions);
      } else if (resumeConversationId && !isValidLettaId(resumeConversationId)) {
        // Invalid ID provided - log warning and fall back to cachedAgentId
        log("WARNING: invalid resumeConversationId, falling back", {
          invalidId: resumeConversationId,
          fallbackTo: cachedAgentId ? "cachedAgentId" : "createAgent"
        });
        if (cachedAgentId) {
          debug("creating session: resumeSession with cachedAgentId (fallback)", { cachedAgentId });
          lettaSession = lettaClient.resumeSession(cachedAgentId, sessionOptions);
        } else {
          debug("creating session: createAgent + createSession (new agent, fallback)");
          cachedAgentId = await createAgentWithoutMemfs();
          lettaSession = lettaClient.createSession(cachedAgentId, sessionOptions);
        }
      } else if (cachedAgentId) {
        // Create new conversation on existing agent
        debug("creating session: createSession with cachedAgentId", { cachedAgentId });
        lettaSession = lettaClient.createSession(cachedAgentId, sessionOptions);
      } else {
        // First time - create new agent and session
        debug("creating session: createAgent + createSession (new agent)");
        cachedAgentId = await createAgentWithoutMemfs();
        debug("created agent", { agentId: cachedAgentId });
        lettaSession = lettaClient.createSession(cachedAgentId, sessionOptions);
      }
      debug("session created successfully");

      // Store for abort handling
      activeLettaSession = lettaSession;

      // Enable memfs on freshly created agents before the first turn
      if (newAgentId) {
        debug("enabling memfs on new agent", { agentId: newAgentId });
        try {
          await enableMemfs(newAgentId, lettaSession);
        } catch (memfsError) {
          log("WARNING: failed to enable memfs on new agent", { error: String(memfsError) });
        }
      }

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
      debug("runLetta finally block, closing session");
      // Sessions own their transport (e.g. a spawned local app-server process),
      // so they must be closed to avoid leaking processes.
      try {
        lettaSession?.close();
      } catch (closeError) {
        debug("error closing session", { error: String(closeError) });
      }
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
