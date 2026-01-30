<div align="center">

# Letta Cowork

[![Platform](https://img.shields.io/badge/platform-%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/letta-ai/letta-cowork/releases)

A desktop application for running Letta Code agents with a visual interface.

</div>

## What is Letta Cowork?

Letta Cowork is a fork of [Claude-Cowork](https://github.com/DevAgentForge/Claude-Cowork) that replaces the Claude SDK with the [`@letta-ai/letta-code-sdk`](https://www.npmjs.com/package/@letta-ai/letta-code-sdk). It provides a native desktop GUI for interacting with [Letta Code](https://github.com/letta-ai/letta-code) agents.

### Why Letta Code SDK?

The [Letta Code SDK](https://github.com/letta-ai/letta-code-sdk) is the SDK interface to [Letta Code](https://github.com/letta-ai/letta-code). Build agents with persistent memory that learn over time.

```typescript
import { createSession, resumeSession } from '@letta-ai/letta-code-sdk';

// First session - agent learns something
const session1 = createSession();
await session1.send('Remember: the secret word is "banana"');
for await (const msg of session1.stream()) { /* ... */ }
const agentId = session1.agentId;
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
- [Letta Code](https://github.com/letta-ai/letta-code) CLI installed
- A running Letta server (local or cloud)

### Environment Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Get your Letta API key from [app.letta.com/settings](https://app.letta.com/settings)

3. Edit `.env` and add your API key:
   ```bash
   LETTA_API_KEY=your-api-key-here
   LETTA_BASE_URL=https://api.letta.com  # This is the default
   ```

**Note:** The app defaults to Letta Cloud (`https://api.letta.com`). For local development, see `.env.example` for localhost configuration.

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

Letta Cowork uses [`@letta-ai/letta-code-sdk`](https://www.npmjs.com/package/@letta-ai/letta-code-sdk) to run agents.

### How It Works

1. The app spawns the Letta Code CLI as a subprocess via the SDK
2. Communication happens via stdin/stdout JSON streaming
3. Each task creates a new conversation (`newConversation: true`)
4. Agent memory persists across conversations via memory blocks

## Development

```bash
# Start development server (hot reload)
bun run dev

# Type checking
bun run build
```

