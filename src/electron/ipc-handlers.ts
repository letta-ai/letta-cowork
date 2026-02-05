import { BrowserWindow } from "electron";
import type { ClientEvent, ServerEvent } from "./types.js";
import { runLetta, type RunnerHandle } from "./libs/runner.js";
import type { PendingPermission } from "./libs/runtime-state.js";
import {
  createRuntimeSession,
  getSession,
  updateSession,
  deleteSession,
} from "./libs/runtime-state.js";

const DEBUG = process.env.DEBUG_IPC === "true";

// Simple logger for IPC handlers
const log = (msg: string, data?: Record<string, unknown>) => {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] [ipc] ${msg}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${timestamp}] [ipc] ${msg}`);
  }
};

// Debug-only logging (verbose)
const debug = (msg: string, data?: Record<string, unknown>) => {
  if (!DEBUG) return;
  log(msg, data);
};

// Track active runner handles
const runnerHandles = new Map<string, RunnerHandle>();

function broadcast(event: ServerEvent) {
  const payload = JSON.stringify(event);
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send("server-event", payload);
  }
}

function emit(event: ServerEvent) {
  // Update runtime state on status changes
  if (event.type === "session.status") {
    updateSession(event.payload.sessionId, { status: event.payload.status });
  }
  broadcast(event);
}

export async function handleClientEvent(event: ClientEvent) {
  debug(`handleClientEvent: ${event.type}`, { payload: 'payload' in event ? event.payload : undefined });
  
  if (event.type === "session.list") {
    // TODO: Implement listing via letta-client once we track agentId
    // For now, return empty - sessions are created via SDK
    emit({ type: "session.list", payload: { sessions: [] } });
    return;
  }

  if (event.type === "session.history") {
    // TODO: Implement history fetch via letta-client
    // For now, return empty - messages stream in real-time
    const conversationId = event.payload.sessionId;
    const status = getSession(conversationId)?.status || "idle";
    emit({
      type: "session.history",
      payload: { sessionId: conversationId, status, messages: [] },
    });
    return;
  }

  if (event.type === "session.start") {
    debug("session.start: starting new session", { prompt: event.payload.prompt.slice(0, 50), cwd: event.payload.cwd });
    const pendingPermissions = new Map<string, PendingPermission>();

    try {
      let conversationId: string | null = null;
      let handle: RunnerHandle | null = null;
      
      debug("session.start: calling runLetta");
      handle = await runLetta({
        prompt: event.payload.prompt,
        session: {
          id: "pending",
          title: event.payload.title,
          status: "running",
          cwd: event.payload.cwd,
          pendingPermissions,
        },
        onEvent: (e) => {
          // Use conversationId for all events
          if (conversationId && "sessionId" in e.payload) {
            const payload = e.payload as { sessionId: string };
            payload.sessionId = conversationId;
          }
          emit(e);
        },
        onSessionUpdate: (updates) => {
          // Called when session is initialized with conversationId
          debug("session.start: onSessionUpdate called", { updates });
          if (updates.lettaConversationId && !conversationId) {
            conversationId = updates.lettaConversationId;
            debug("session.start: session initialized", { conversationId });
            
            createRuntimeSession(conversationId);
            updateSession(conversationId, { status: "running" });
            if (handle) runnerHandles.set(conversationId, handle);
            
            // Emit session.status to unblock UI - use conversationId as title
            emit({
              type: "session.status",
              payload: { sessionId: conversationId, status: "running", title: conversationId, cwd: event.payload.cwd },
            });
            emit({
              type: "stream.user_prompt",
              payload: { sessionId: conversationId, prompt: event.payload.prompt },
            });
          }
        },
      });
      debug("session.start: runLetta returned handle");
    } catch (error) {
      log("session.start: ERROR", { error: String(error) });
      console.error("Failed to start session:", error);
      emit({
        type: "runner.error",
        payload: { message: String(error) },
      });
    }
    return;
  }

  if (event.type === "session.continue") {
    const conversationId = event.payload.sessionId;
    debug("session.continue: continuing session", { conversationId, prompt: event.payload.prompt.slice(0, 50) });
    
    let runtimeSession = getSession(conversationId);
    
    if (!runtimeSession) {
      debug("session.continue: no runtime session found, creating new one");
      runtimeSession = createRuntimeSession(conversationId);
    } else {
      debug("session.continue: found existing runtime session", { status: runtimeSession.status });
    }

    updateSession(conversationId, { status: "running" });
    emit({
      type: "session.status",
      payload: { sessionId: conversationId, status: "running" },
    });

    emit({
      type: "stream.user_prompt",
      payload: { sessionId: conversationId, prompt: event.payload.prompt },
    });

    try {
      debug("session.continue: calling runLetta", { conversationId });
      let actualConversationId = conversationId;
      
      const handle = await runLetta({
        prompt: event.payload.prompt,
        session: {
          id: conversationId,
          title: conversationId,
          status: "running",
          cwd: event.payload.cwd,
          pendingPermissions: runtimeSession.pendingPermissions,
        },
        resumeConversationId: conversationId,
        onEvent: (e) => {
          // Update sessionId in events if we got a new conversationId
          if (actualConversationId !== conversationId && "sessionId" in e.payload) {
            const payload = e.payload as { sessionId: string };
            payload.sessionId = actualConversationId;
          }
          emit(e);
        },
        onSessionUpdate: (updates) => {
          // If we get a new conversationId (e.g., fallback from invalid ID), update everything
          if (updates.lettaConversationId && updates.lettaConversationId !== conversationId) {
            log("session.continue: received new conversationId from runner", { 
              old: conversationId, 
              new: updates.lettaConversationId 
            });
            actualConversationId = updates.lettaConversationId;
            
            // Delete the old invalid session from UI and runtime state
            deleteSession(conversationId);
            emit({ type: "session.deleted", payload: { sessionId: conversationId } });
            
            // Create new runtime session for the actual conversation
            createRuntimeSession(actualConversationId);
            updateSession(actualConversationId, { status: "running" });
            
            // Notify UI about the new session
            emit({
              type: "session.status",
              payload: { 
                sessionId: actualConversationId, 
                status: "running", 
                title: actualConversationId, 
                cwd: event.payload.cwd 
              },
            });
            // Re-emit the user prompt for the new session
            emit({
              type: "stream.user_prompt",
              payload: { sessionId: actualConversationId, prompt: event.payload.prompt },
            });
          }
        },
      });
      debug("session.continue: runLetta returned handle");
      runnerHandles.set(actualConversationId, handle);
    } catch (error) {
      log("session.continue: ERROR", { error: String(error) });
      updateSession(conversationId, { status: "error" });
      emit({
        type: "session.status",
        payload: { sessionId: conversationId, status: "error", error: String(error) },
      });
    }
    return;
  }

  if (event.type === "session.stop") {
    const conversationId = event.payload.sessionId;
    debug("session.stop: stopping session", { conversationId });
    const handle = runnerHandles.get(conversationId);
    if (handle) {
      debug("session.stop: aborting handle");
      handle.abort();
      runnerHandles.delete(conversationId);
    } else {
      debug("session.stop: no handle found");
    }
    updateSession(conversationId, { status: "idle" });
    emit({
      type: "session.status",
      payload: { sessionId: conversationId, status: "idle" },
    });
    return;
  }

  if (event.type === "session.delete") {
    const conversationId = event.payload.sessionId;
    const handle = runnerHandles.get(conversationId);
    if (handle) {
      handle.abort();
      runnerHandles.delete(conversationId);
    }
    deleteSession(conversationId);
    
    // Note: Letta client may not have a delete method for conversations
    // The conversation will remain in Letta but be removed from our UI
    
    emit({ type: "session.deleted", payload: { sessionId: conversationId } });
    return;
  }

  if (event.type === "permission.response") {
    const session = getSession(event.payload.sessionId);
    if (!session) return;

    const pending = session.pendingPermissions.get(event.payload.toolUseId);
    if (pending) {
      pending.resolve(event.payload.result);
    }
    return;
  }
}

export function cleanupAllSessions(): void {
  for (const [, handle] of runnerHandles) {
    handle.abort();
  }
  runnerHandles.clear();
}
