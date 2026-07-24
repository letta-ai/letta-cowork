<div align="center">

# Demo open-source UI, built using the Letta Agent SDK

[![Platform](https://img.shields.io/badge/platform-%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/letta-ai/letta-cowork/releases)

An example desktop application for running Letta agents with a visual interface.

</div>

## What is the Letta OSS UI?

This repo contains an example desktop application for running Letta agents with a visual interface. The code is a fork of [Claude-Cowork](https://github.com/DevAgentForge/Claude-Cowork) that replaces the Claude SDK with the [`@letta-ai/letta-agent-sdk`](https://www.npmjs.com/package/@letta-ai/letta-agent-sdk). It provides a native desktop GUI for interacting with [Letta](https://docs.letta.com/agent-sdk) agents.

https://github.com/user-attachments/assets/570474a1-641b-404d-a1aa-50c080675773

### Why Letta Agent SDK?

The [Letta Agent SDK](https://docs.letta.com/agent-sdk) is the SDK interface to [Letta Code](https://github.com/letta-ai/letta-code). Build agents with persistent memory that learn over time.

```typescript
import { createAgent, resumeSession } from '@letta-ai/letta-agent-sdk';

// First session - agent learns something
const agentId = await createAgent();
const session1 = resumeSession(agentId);
await session1.send('Remember: the secret word is "banana"');
for await (const msg of session1.stream()) { /* ... */ }
session1.close();

// Later... agent still remembers
await using session2 = resumeSession(agentId);
await session2.send('What is the secret word?');
for await (const msg of session2.stream()) {
  if (msg.type === 'assistant') console.log(msg.content); // "banana"
}
```

**Key concepts:**
- **Agent** (`agentId`): Persistent entity with memory that survives across sessions
- **Conversation** (`conversationId`): A message thread within an agent
- **Session** (`sessionId`): A single execution/connection

Agents remember across conversations (via memory blocks), but each conversation has its own message history. This means you can run multiple concurrent conversations with the same agent - each conversation has its own message history while sharing the agent's persistent memory.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) or Node.js 22+
- For cloud mode: a Letta API key from [app.letta.com/settings](https://app.letta.com/settings)

### Environment Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Pick a backend in `.env` (see `.env.example` for all options):

   **Letta Cloud** (agents stored in the cloud, tools run on your machine):
   ```bash
   LETTA_BACKEND=cloud
   LETTA_API_KEY=your-api-key-here
   ```

   **Fully local runtime** (agents stored on your machine, no API key):
   ```bash
   LETTA_BACKEND=local
   ```

   **Self-hosted app server** (see [self-hosting docs](https://docs.letta.com/self-hosting)):
   ```bash
   # In another terminal: letta server --backend local --listen ws://127.0.0.1:4500
   LETTA_BACKEND=remote
   LETTA_SERVER_URL=ws://127.0.0.1:4500
   ```

   If `LETTA_BACKEND` is unset, the app uses cloud when `LETTA_API_KEY` is set and local otherwise.

### Running the App

```bash
# Clone the repository
git clone https://github.com/letta-ai/letta-cowork.git
cd letta-cowork

# Install dependencies
bun install

# Run in development mode
bun run dev
```

## Architecture

The OSS UI uses [`@letta-ai/letta-agent-sdk`](https://www.npmjs.com/package/@letta-ai/letta-agent-sdk) to run agents.

### How It Works

1. The app talks to a Letta app server through the SDK:
   - `local` / `cloud` backends: the SDK spawns and manages a bundled local app server (`@letta-ai/letta-code`)
   - `remote` backend: the SDK connects to your self-hosted app server over WebSocket
2. Each task resumes the app's agent (created on first run) as a new SDK session
3. Agent memory persists across conversations via memory blocks

## Development

```bash
# Start development server (hot reload)
bun run dev

# Type checking
bun run build
```
