"""Local AgentOS runtime for the Anaga voice-agent operations workspace.

This service exists separately from the Vercel web/API deployment. The AgentOS
Control Plane connects directly from the browser to this process at
http://localhost:8000 in development. It does not expose Firebase credentials,
and it is intentionally not an outbound-calling service.
"""

from __future__ import annotations

import os
from pathlib import Path

from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.os import AgentOS
from fastapi.middleware.cors import CORSMiddleware

ROOT = Path(__file__).resolve().parent
DATABASE_URL = f"sqlite:///{ROOT / 'agentos.db'}"
HOST = os.getenv("AGENTOS_HOST", "0.0.0.0")
PORT = int(os.getenv("AGENTOS_PORT", "8000"))

operations_agent = Agent(
    id="anaga-operations",
    name="Anaga Operations",
    description="Operations assistant for the Anaga voice-agent platform.",
    instructions=[
        "Help operators understand the Anaga voice-agent platform.",
        "Never claim that a customer call was placed unless a confirmed call record exists.",
        "Treat contact data, credentials, and transcripts as sensitive.",
        "Escalate production action requests to an authorized human operator.",
    ],
    db=SqliteDb(db_url=DATABASE_URL),
    add_history_to_context=True,
    num_history_runs=3,
    markdown=True,
)

agent_os = AgentOS(
    id="anaga-agentos",
    name="Anaga Voice Operations",
    description="Local control-plane runtime for the Anaga voice-agent platform.",
    agents=[operations_agent],
    db=SqliteDb(db_url=DATABASE_URL),
    tracing=True,
)
app = agent_os.get_app()

# AgentOS is managed from os.agno.com. Restrict browser access to that Control
# Plane and local development, rather than adding a permissive wildcard policy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://os.agno.com", "http://localhost:8000", "http://127.0.0.1:8000"],
    # The Control Plane sends its status request with credentials included. The
    # origin list remains explicit, so enabling this does not allow arbitrary
    # websites to read the local runtime.
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)


if __name__ == "__main__":
    agent_os.serve(app="app:app", host=HOST, port=PORT, reload=False)
