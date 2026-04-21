# x-bot

A lightweight HTTP service for generating and posting X / Twitter content through MiniMax plus a browser-automation posting layer.

The service exposes a small compatibility API so other systems can request:

- LLM-generated posts from article metadata
- raw text posting
- text + media posting
- health checks for downstream automation dependencies

## Highlights

- Simple Node.js HTTP server with JSON endpoints
- MiniMax-powered content generation
- Fallback post generation when the LLM call fails
- Integration with a unified platform browser manager for actual posting
- Support for raw media posts

## API

- `GET /health`
- `POST /post`
- `POST /post/raw`
- `POST /post/media/raw`

## Tech Stack

- Node.js (ES modules)
- MiniMax API
- OpenCLI / browser automation integration
- Docker Compose
- Optional Python helper for media posting workflows

## Getting Started

### Prerequisites

- Node.js 18+
- A valid MiniMax API key
- A reachable browser automation / CDP setup for X posting

### Local run

```bash
cp .env.local.example .env.local
npm install
node server.mjs
```

The service listens on port `7710` by default.

### Docker

```bash
docker compose up --build
```

## Environment Variables

- `MINIMAX_API_KEY`
- `MINIMAX_MODEL`
- `MINIMAX_API_BASE`
- `XBOT_LANGUAGE`
- `X_CDP_URL`
- `OPENCLI_CDP_TARGET`

## Notes

- This repository focuses on the HTTP posting layer and content generation glue, not on a full social-media dashboard.
- The real posting capability depends on the external browser automation environment being available.
