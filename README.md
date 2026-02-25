# Rick — Personal AI Agent on WhatsApp

Rick is a personal AI assistant that runs entirely on WhatsApp. You message yourself, and Rick answers — with persistent memory, multi-LLM routing, browser automation, code editing, and zero server cost.

Built on Oracle Cloud Always Free VMs, Rick orchestrates multiple LLM providers and spawns isolated Docker containers for specialized tasks like coding (Claude Code) and web research (Gemini Pro + Playwright).

## Architecture

```
 WhatsApp (self-chat)
       │
  WhatsAppClient (Baileys v7)
       │
     Agent (orchestrator)
       │
  ┌────┼──────────┬──────────────┐
  │    │          │              │
Classifier  LLMService    MemoryService
(Gemini)   (multi-LLM)   (PG + pgvector)
  │         │              │
  ▼         ▼              │
SessionManager   OAuth     │
  │          (Claude/GPT)  │
  ├─────────┐              │
  │         │              │
Code      Research         │
Container Container        │
(Claude)  (Gemini+PW)      │
```

### How a message flows

1. **WhatsAppClient** receives a message via Baileys, filters for self-chat only, extracts text/audio/image
2. **Agent.handleMessage()** serializes per user (message queue prevents race conditions) and routes it:
   - `/commands` → slash command handler
   - Edit mode active → Claude Code container
   - Audio → transcribed to text via Gemini, then routed normally
   - Active sub-agent session → relay (continuation, close, or nag)
   - Otherwise → **Classifier** decides: `SELF` (direct chat), `CODE` (Claude sub-agent), or `RESEARCH` (research sub-agent)
3. For `SELF`: Gemini Flash responds with conversation history + memory context
4. For `CODE`/`RESEARCH`: a Docker container is spawned, credentials injected, output streamed back to WhatsApp

## Features

### Multi-LLM Routing

| Model | Provider | Used For |
|-------|----------|----------|
| Gemini 3 Flash Preview | Google | Default chat, classifier, audio transcription, memory extraction |
| Gemini 3.1 Pro Preview | Google | Research sub-agent (browser automation + web search) |
| Claude Opus 4.6 | Anthropic | Code sub-agent, edit mode (primary) |
| GPT-5.3 Codex | OpenAI | Code sub-agent (fallback when Claude hits rate limit) |

No API keys needed for Claude or GPT — Rick uses OAuth 2.0 + PKCE to connect via your existing Pro/Max subscriptions.

### Persistent Memory

Rick has two memory systems working together:

- **Structured memory** (PostgreSQL) — key-value pairs organized by category (credentials, personal info, notes, preferences). Supports exact match, Portuguese full-text search, and ILIKE fallback.
- **Semantic memory** (pgvector) — conversation embeddings via Gemini's embedding model (768 dimensions, HNSW index). Enables "search by meaning" for past conversations.

Memories are extracted automatically:
- Regex patterns catch simple cases ("meu nome é João", "minha senha do github é...")
- LLM extraction (Gemini Flash) handles complex cases when the assistant confirms saving something
- Every non-trivial conversation is embedded into vector memory

Credential memories are protected: partial extractions cannot overwrite richer existing values (smart merge).

Credentials in sensitive categories (`senhas`, `credenciais`, `tokens`, `passwords`, `secrets`) are **encrypted at rest** with AES-256-GCM. The encryption key is derived from `MEMORY_ENCRYPTION_KEY` via scrypt. Encrypted values are stored as `enc:iv:authTag:ciphertext` and decrypted transparently on read. Legacy plaintext values are handled gracefully (backward-compatible).

Tables are automatically pruned to prevent unbounded growth:
- `conversations`: capped at 500 messages per user
- `message_log`: capped at 5000 entries globally

### Sub-Agents

#### Code Sub-Agent (Claude Code)

Runs Claude Code CLI inside an isolated Docker container with:
- Full access to a staging copy of the codebase (edit mode) or a clean workspace (task mode)
- Playwright MCP server for browser-based debugging
- NDJSON stream parsing for real-time output to WhatsApp
- Automatic GPT Codex fallback on Claude rate limits or credit exhaustion
- OAuth credentials injected at runtime (no API keys stored in container)

#### Research Sub-Agent (Gemini Pro + Playwright)

Two modes:
- **Browser automation** — Gemini Pro drives a headless Chromium browser via function calling. It reads accessibility snapshots (YAML), decides what to click/fill, and can log into accounts using stored credentials + TOTP 2FA.
- **Web search** — Gemini Pro with Google Search grounding for public information queries.

Safety features:
- **Automation guard** — Prevents infinite loops, excessive scrolling, and repetitive scraping. Tracks per-tool usage, consecutive exploration actions, and repeat patterns. Cuts off early with a summary if the agent gets stuck.
- **Anti-hallucination** — The LLM only reports what it actually sees on the page. The system prompt forbids fabricating data.

### Self-Editing (`/edit` mode)

Rick can edit his own source code:

1. `/edit` — Starts an edit session. Creates a staging copy of `src/`, launches a Claude Code container with the workspace mounted.
2. Send prompts describing what to change — Claude Code edits the files directly.
3. `/deploy` — Triggers the deploy pipeline:
   - Backup current `src/` → build candidate image → smoke test (health-only mode) → swap containers → 60s watchdog → rollback on failure
4. `/edit sair` — Exits edit mode without deploying.

### Audio & Image Support

- **Audio** — Transcribed via Gemini Flash multimodal API, then routed through the normal pipeline (commands, classifier, sub-agents). No more bypassing to simple chat.
- **Images** — Passed to Gemini Flash for visual understanding in chat, or injected into Claude Code containers via `--image` flag in edit mode.

### Session Management

Sub-agent sessions have a lifecycle: `starting` → `running` → `done` → `killed`.

- When a task finishes, Rick sends a "Posso encerrar?" poll
- Follow-up messages are detected via topic matching (shared keywords + demonstrative references)
- Context is preserved across follow-ups: original task description + previous output + credentials are passed to the research agent
- Multiple close commands recognized: "ok", "pronto", "encerrar", "pode encerrar", "encerrar tudo"

### Commands

| Command | Description |
|---------|-------------|
| `/edit` | Start edit mode (Claude Code on Rick's own source) |
| `/edit sair` | Exit edit mode |
| `/deploy` | Deploy staged changes (build + smoke test + swap + watchdog) |
| `/status` | Show active sessions, memory stats, connected providers |
| `/conectar claude` | Start Claude OAuth flow |
| `/conectar gpt` | Start GPT OAuth flow |
| `/desconectar claude` | Disconnect Claude |
| `/desconectar gpt` | Disconnect GPT |
| `/lembrar [cat:]key = value` | Save a memory |
| `/esquecer key` | Delete a memory |
| `/memorias [category]` | List memories |
| `/limpar` | Clear conversation history |

## Project Structure

```
zap-agent/
├── src/
│   ├── index.ts                    # Entry point (bootstrap)
│   ├── agent.ts                    # Core orchestrator (1700+ lines)
│   ├── health.ts                   # HTTP health check server
│   ├── types.d.ts                  # Ambient type declarations
│   ├── config/
│   │   ├── env.ts                  # Environment config
│   │   └── logger.ts               # Pino logger
│   ├── whatsapp/
│   │   └── client.ts               # Baileys client (self-chat, polls, media)
│   ├── llm/
│   │   ├── llm-service.ts          # Provider abstraction + model switching
│   │   ├── types.ts                # Model registry + shared types
│   │   └── providers/
│   │       ├── gemini.ts            # Gemini (multimodal)
│   │       ├── anthropic.ts         # Anthropic (API key + OAuth)
│   │       └── openai.ts            # OpenAI (API key + Codex OAuth)
│   ├── auth/
│   │   ├── claude-oauth.ts          # Claude OAuth 2.0 + PKCE
│   │   └── openai-oauth.ts          # OpenAI OAuth 2.0 + PKCE
│   ├── memory/
│   │   ├── db.ts                    # PostgreSQL pool (structured)
│   │   ├── memory-service.ts        # CRUD: memories, conversations, users, message tracking
│   │   ├── crypto.ts                # AES-256-GCM encryption for sensitive memories
│   │   ├── migrate.ts               # Schema migrations (structured DB)
│   │   ├── vector-db.ts             # PostgreSQL pool (pgvector)
│   │   ├── vector-memory-service.ts # Semantic search, dedup, eviction
│   │   ├── vector-migrate.ts        # Schema migrations (vector DB)
│   │   ├── embedding-service.ts     # Gemini embeddings (768 dims)
│   │   └── disk-monitor.ts          # Periodic DB size check + LRU eviction
│   └── subagent/
│       ├── classifier.ts            # Gemini Flash task classifier
│       ├── types.ts                 # Session/task type definitions
│       ├── session-manager.ts       # Docker container lifecycle
│       └── edit-session.ts          # Self-editing mode (Claude Code)
├── docker/
│   ├── subagent-claude.Dockerfile   # Claude Code + Playwright MCP image
│   └── subagent-research/
│       ├── Dockerfile               # Chromium + Playwright + research script
│       └── research.mjs             # Agentic browser automation / web search
├── scripts/
│   └── deploy.sh                    # Safe deploy pipeline (backup → build → smoke → swap → watchdog)
├── Dockerfile                       # Main agent image (includes Docker CLI)
├── docker-compose.yml               # Agent service definition
├── deploy-db.sh                     # PostgreSQL deploy on Oracle Cloud
├── setup-oracle.sh                  # Oracle Cloud VM initial setup
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── AGENTS.md                        # Instructions for AI agents
├── CLAUDE.md                        # Instructions for Claude
└── GEMINI.md                        # Instructions for Gemini
```

## Infrastructure

All infrastructure runs on Oracle Cloud Always Free tier — zero cost.

| VM | Specs | Role | IP |
|----|-------|------|----|
| cluster-24g | ARM A1.Flex, 4 cores, 24 GB RAM | Rick + sub-agent containers | `137.131.219.123` |
| docker-1g (structured) | AMD Micro, 1 GB RAM | PostgreSQL (memories, conversations, users, OAuth) | `137.131.241.200` |
| docker-1g (vector) | AMD Micro, 1 GB RAM | pgvector (semantic embeddings) | `137.131.239.197` |

### Container Topology

```
Host Docker (cluster-24g)
│
├── zap-agent-agent-1          # Main Rick container (always running)
│   ├── Mounts docker.sock     # Creates/manages child containers
│   ├── Mounts auth_info/      # WhatsApp session persistence
│   └── Port 3000              # Health check
│
├── subagent-claude-*          # Ephemeral, created per code task
│   └── Claude Code CLI + Playwright MCP
│
└── subagent-research-*        # Ephemeral, created per research task
    └── research.mjs + Playwright + Chromium
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google AI Studio API key |
| `DATABASE_URL` | Yes | PostgreSQL connection string (structured DB) |
| `VECTOR_DATABASE_URL` | No | pgvector connection string (semantic memory) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (alternative to OAuth) |
| `OPENAI_API_KEY` | No | OpenAI API key (alternative to OAuth) |
| `MEMORY_ENCRYPTION_KEY` | No | Passphrase for AES-256-GCM encryption of credential memories. If unset, credentials stored as plaintext. |
| `AGENT_NAME` | No | Agent display name (default: "Jarvis") |
| `AGENT_LANGUAGE` | No | Agent language (default: "pt-BR") |
| `OWNER_PHONE` | No | Owner's phone number for permission checks |
| `CONVERSATION_HISTORY_LIMIT` | No | Max messages in conversation context (default: 20) |
| `MAX_MEMORIES_PER_USER` | No | Max structured memories per user (default: 500) |
| `HOST_PROJECT_DIR` | No | Host path to project dir (for edit mode staging) |
| `VECTOR_DB_MAX_SIZE_MB` | No | Max vector DB size before eviction (default: 36864) |
| `DISK_MONITOR_INTERVAL_MINUTES` | No | Disk check interval (default: 10) |

## Database Schema

### Structured DB

```sql
users (id, phone, name, is_owner, created_at, updated_at)
memories (id, user_phone, category, key, value, metadata, created_at, updated_at)
  -- UNIQUE (user_phone, category, key)
  -- GIN index on to_tsvector('portuguese', key || ' ' || value)
conversations (id, user_phone, role, content, model_used, tokens_used, created_at)
message_log (id, wa_message_id, author, content, created_at)
oauth_tokens (id, user_phone, provider, access_token, refresh_token, expires_at, ...)
```

### Vector DB

```sql
memory_embeddings (id, user_phone, content, category, source, embedding vector(768),
                   metadata, hit_count, last_hit_at, created_at)
  -- HNSW index (m=16, ef_construction=64, cosine distance)
```

## Deploy Pipeline

The deploy pipeline (`scripts/deploy.sh`) ensures safe self-editing:

```
1. Backup current src/ → src.bak/
2. Copy staged files from edit session
3. Build candidate Docker image (TypeScript errors = fail)
4. Start candidate in HEALTH_ONLY mode on port 3001
5. Health check (20 attempts, 3s apart)
6. If healthy → re-tag candidate as main image, docker compose up -d (no rebuild)
7. Watchdog: monitor health for 60s (12 checks, 5s apart)
8. On any failure → rollback (restore backup, rebuild)
```

Exit codes: `0` = success, `1` = build fail, `2` = smoke test fail, `3` = watchdog fail (rollback OK), `4` = rollback also failed (CRITICAL).

## Quick Start

```bash
# 1. Clone and configure
git clone <repo-url> zap-agent
cd zap-agent
cp .env.example .env
# Edit .env with your GEMINI_API_KEY and DATABASE_URL

# 2. Deploy PostgreSQL (optional — uses Oracle Cloud VM)
./deploy-db.sh

# 3. Build and start
docker compose up -d --build

# 4. Pair WhatsApp
docker compose logs -f agent
# Scan the QR code with WhatsApp (Linked Devices)

# 5. Message yourself on WhatsApp
# Rick will respond to your self-chat messages
```

## Security

- **No shell injection** — Sub-agent prompts are passed as direct `execve()` arguments via Node's `spawn()`, never interpolated into `sh -c` strings. Images are injected via `docker cp`, not shell pipes.
- **Credential separation** — User credentials are stored in a dedicated `credentials` field on sessions, never embedded in task descriptions. They are injected only at the point of execution and never appear in log output.
- **Encryption at rest** — Sensitive memory categories are encrypted with AES-256-GCM (key derived from `MEMORY_ENCRYPTION_KEY` via scrypt). Backward-compatible with legacy plaintext values.
- **Per-user message serialization** — A promise-chain queue prevents race conditions from concurrent messages mutating shared state.
- **LLM call timeouts** — All LLM providers (Gemini, Anthropic, OpenAI) have 60-second timeouts to prevent indefinite hangs.
- **Automatic table pruning** — Conversation history and message logs are capped to prevent unbounded database growth.
- **Memory deletion protection** — Memories can only be deleted via the explicit `/esquecer` command, never through casual conversation patterns.

## Tech Stack

- **Runtime**: Node.js 22 + TypeScript
- **WhatsApp**: Baileys v7 (unofficial WhatsApp Web API)
- **LLMs**: Gemini (Google AI SDK), Anthropic SDK, OpenAI SDK
- **Browser Automation**: Playwright (headless Chromium)
- **Databases**: PostgreSQL 16 + pgvector
- **Embeddings**: Gemini Embedding 001 (768 dimensions)
- **Containers**: Docker + Docker Compose
- **Infrastructure**: Oracle Cloud Always Free (ARM A1.Flex + AMD Micro)
- **Auth**: OAuth 2.0 + PKCE (Claude, OpenAI)
