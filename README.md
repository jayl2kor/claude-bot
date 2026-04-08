# claude-pet

Persistent AI persona daemon powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Run multiple AI pets on Discord/Telegram, each with its own personality, long-term memory, and the ability to use tools — like having AI teammates that remember you and grow over time.

## Features

- **Persistent Persona** — Each pet has a configurable personality (Bones) that evolves through interaction (Soul)
- **Long-term Memory** — Remembers users, conversations, teachings, and reflections across sessions
- **Multi-channel** — Discord, Telegram, and CLI adapters with a plugin interface for more
- **Teachable** — Say "기억해: X" and the pet stores it; correct it and it updates
- **Multi-pet** — Run multiple pets simultaneously, each in its own Docker container
- **Pet Collaboration** — Pets can split work and merge results via shared task queue
- **Agentic** — Full tool access (file read/write, bash, search) — not just chat
- **Proactive Care** — Monitors your activity and suggests breaks during late-night sessions
- **Conversation History** — Understands "아까 그거" (back-references) by searching past conversations
- **Slash Commands** — `/기억 keyword` to search stored knowledge from Discord

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Docker Host                       │
│                                                      │
│  ┌──────────────────┐    ┌──────────────────┐       │
│  │  Pet A (Docker)   │    │  Pet B (Docker)   │       │
│  │                   │    │                   │       │
│  │  ┌─────────────┐ │    │  ┌─────────────┐ │       │
│  │  │ Discord/TG  │ │    │  │ Discord/TG  │ │       │
│  │  │  Adapter    │ │    │  │  Adapter    │ │       │
│  │  └──────┬──────┘ │    │  └──────┬──────┘ │       │
│  │         │         │    │         │         │       │
│  │  ┌──────▼──────┐ │    │  ┌──────▼──────┐ │       │
│  │  │   Router    │ │    │  │   Router    │ │       │
│  │  │ + Teaching  │ │    │  │ + Teaching  │ │       │
│  │  └──────┬──────┘ │    │  └──────┬──────┘ │       │
│  │         │         │    │         │         │       │
│  │  ┌──────▼──────┐ │    │  ┌──────▼──────┐ │       │
│  │  │ Claude CLI  │ │    │  │ Claude CLI  │ │       │
│  │  │  (spawn)    │ │    │  │  (spawn)    │ │       │
│  │  └─────────────┘ │    │  └─────────────┘ │       │
│  │                   │    │                   │       │
│  │  📁 data/pet-a/  │    │  📁 data/pet-b/  │       │
│  │   (isolated vol) │    │   (isolated vol) │       │
│  └────────┬──────────┘    └────────┬──────────┘       │
│           │    Shared Volumes      │                  │
│           └────────┬───────────────┘                  │
│                    │                                  │
│         📁 shared-tasks/  (collaboration)             │
│         📁 shared-status/ (inter-pet visibility)      │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [Docker](https://docs.docker.com/get-docker/) (for containerized deployment)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) logged in
- Discord bot token(s) from [Discord Developer Portal](https://discord.com/developers/applications)

### 1. Clone and Install

```bash
git clone https://github.com/jayl2kor/claude-bot.git
cd claude-bot
npm install
```

### 2. Configure Your Pet

```bash
# Create pet config
mkdir -p config/mypet
```

**config/mypet/persona.yaml**
```yaml
name: "MyPet"
personality: "Friendly and helpful AI assistant"
tone: casual       # casual | formal | playful
values:
  - honesty
  - helpfulness
constraints:
  - Never make up information
```

**config/mypet/channels.yaml**
```yaml
discord:
  token: ${DISCORD_BOT_TOKEN}
  respondTo: both  # mention | dm | both
```

**config/mypet/daemon.yaml**
```yaml
maxConcurrentSessions: 10
sessionTimeoutMs: 1800000   # 30 min
backend: claude             # claude | codex
model: sonnet
maxTurns: 10
skipPermissions: true       # Allow tool use without confirmation
```

### 3. Set Up Environment

```bash
# Create .env.mypet
echo "DISCORD_BOT_TOKEN=your-discord-bot-token" > .env.mypet
```

### 4. Run

**Local (single pet):**
```bash
npx tsx src/main.ts --pet mypet
```

**CLI mode (no Discord needed):**
```bash
npx tsx src/main.ts
# Falls back to stdin/stdout interactive mode
```

**Docker (multiple pets):**
```bash
# Edit docker-compose.yml to add your pet service
docker compose build
docker compose up -d

# Login Claude CLI inside each container (first time only)
docker compose exec mypet claude login
```

## Running Multiple Pets

Each pet runs in its own Docker container with isolated memory and shared collaboration volumes.

**docker-compose.yml:**
```yaml
services:
  pet-a:
    build: .
    env_file: .env.pet-a
    environment:
      CLAUDE_PET_ROOT: /app
    volumes:
      - ./config/pet-a:/app/config/pet-a:ro
      - pet-a-data:/app/data/pet-a
      - shared-tasks:/app/data/shared/tasks
      - shared-status:/app/data/shared/status
    command: ["--pet", "pet-a"]
    init: true
    restart: unless-stopped

  pet-b:
    # Same structure, different config/env
```

```bash
docker compose up -d
docker compose logs -f        # Watch both pets
docker compose restart pet-a  # Restart one pet
```

## Memory System

Each pet maintains persistent memory across sessions:

| Type | Purpose | Auto-updated |
|------|---------|:---:|
| **Persona Soul** | Learned traits, communication style | ✅ (daily cron) |
| **Relationships** | Per-user notes, preferences, interaction count | ✅ |
| **Knowledge** | Facts taught by users ("기억해: X") | ✅ |
| **Reflections** | Session summaries and insights | ✅ |
| **History** | Full conversation history per channel | ✅ |
| **Activity** | User activity patterns for proactive care | ✅ |

**Teaching your pet:**
```
You:  기억해: 나는 백엔드 개발자야
Pet:  기억하겠습니다!

You:  아니야, 사실은 풀스택이야
Pet:  수정했습니다! (corrects stored knowledge)
```

## Pet Collaboration

When multiple pets are running, they can collaborate on tasks:

```
You:  @PetA @PetB 이 프로젝트 같이 분석해줘
→ PetA handles backend analysis
→ PetB handles frontend analysis
→ Results are merged and returned
```

Enable in `daemon.yaml`:
```yaml
collaboration:
  enabled: true
  role: backend   # Each pet gets a different role
  sharedDir: /app/data/shared/tasks
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/기억 keyword` | Search stored knowledge, reflections, and notes |

## Cron Jobs

Built-in background tasks:

| Job | Interval | Purpose |
|-----|----------|---------|
| memory-reflection | 6h | Consolidate session reflections |
| soul-evolution | 24h | Evolve persona based on accumulated knowledge |
| knowledge-dedup | 12h | Merge duplicate knowledge entries |
| session-cleanup | 24h | Archive sessions older than 30 days |
| activity-monitor | 10min | Send care messages for late-night/long sessions |
| history-prune | 24h | Prune conversation history older than 7 days |
| status-heartbeat | 15s | Publish pet status for inter-pet visibility |

## Project Structure

```
src/
├── main.ts                      # Entry point
├── daemon/                      # Process lifecycle, crash recovery
├── executor/                    # Claude CLI spawn + NDJSON parsing
├── session/                     # Concurrent session management
├── memory/                      # Persona, knowledge, relationships, etc.
├── context/                     # System prompt builder with token budgets
├── channel/                     # Discord, Telegram, CLI adapters
├── plugins/                     # Channel plugin interface
├── teaching/                    # Teaching detection + knowledge extraction
├── cron/                        # Background job scheduler
├── collaboration/               # Multi-pet task coordination
├── commands/                    # Slash command handlers
├── status/                      # Inter-pet status sharing
├── delivery/                    # Failed message retry queue
└── utils/                       # Config, errors, backoff, logger, etc.
```

## Configuration Reference

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_PET_ROOT` | Project root directory (default: cwd) |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `ANTHROPIC_API_KEY` | API key (alternative to OAuth login) |

### persona.yaml

```yaml
name: string            # Pet's name
personality: string     # Personality description
tone: casual|formal|playful
values: string[]        # Core values
constraints: string[]   # Behavioral constraints
```

### daemon.yaml

```yaml
maxConcurrentSessions: number   # Max parallel Claude processes (default: 10)
sessionTimeoutMs: number        # Session timeout in ms (default: 1800000)
backend: claude|codex           # Executor backend (default: claude)
model: string                   # Backend model name (default: sonnet)
claudeModel: string             # Legacy alias; falls back to model
maxTurns: number                # Max agentic turns per session (default: 10)
skipPermissions: boolean        # Skip tool confirmation (default: false)
workspacePath: string           # Working directory for Claude CLI
sharedStatusDir: string         # Shared status directory path
collaboration:
  enabled: boolean
  role: string                  # Pet's role in collaboration
  sharedDir: string             # Shared task directory
git:
  enabled: boolean
  branch: string                # Git branch for this pet
  autoSync: boolean             # Auto pull/push
```

## Development

```bash
npm install              # Install dependencies
npm run dev              # Run with hot reload (tsx watch)
npm run build            # Compile TypeScript
npm test                 # Run tests
npm run lint             # Lint with biome
```

## How It Works

1. **Message arrives** via Discord/Telegram adapter
2. **Router** deduplicates, detects teaching intents, records activity
3. **Context Builder** assembles system prompt from persona + memory + history + other pets' status
4. **Spawner** executes `claude -p` with the prompt via `--system-prompt-file`
5. **Streamed response** is sent back to the channel as it arrives
6. **Post-session** integration runs: reflection generation, knowledge extraction, relationship notes

Each message spawns a fresh Claude CLI process. Session continuity is achieved through the memory system, not CLI session persistence.

## License

MIT
