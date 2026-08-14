# Local AgentOS Runtime

This directory provides a **local AgentOS control-plane runtime** for the Anaga voice-agent workspace. It resolves the AgentOS connection error caused by having no AgentOS server available at the Control Plane’s configured local endpoint.

The runtime is intentionally separate from the Vercel application. Vercel continues to host the web/API layer and Firestore integration; AgentOS is a persistent FastAPI process used for operator tooling, sessions, and tracing.

## Local startup

Install the pinned runtime dependency and start the service:

```bash
sudo uv pip install --system -r agentos/requirements.txt
python3 agentos/app.py
```

The service listens on `http://localhost:8000` by default. It exposes the AgentOS health and API endpoints, including `http://localhost:8000/docs`.

## Control Plane connection

Open [AgentOS](https://os.agno.com), select **Local**, use the name **Local AgentOS**, and enter:

```text
http://localhost:8000
```

The AgentOS browser must permit `os.agno.com` to access the local network. In Chrome or Edge, allow the local-network permission request. Do not use a public tunnel until authorization has been configured.

## Production boundary

This local process is suitable for development and proof-of-connection only. It is not an outbound-calling service and does not contain Firebase credentials. A production AgentOS deployment needs a persistent HTTPS host, a database suitable for retained sessions/traces, and authorization configured before exposing a public endpoint.
