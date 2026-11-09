# TechAssist.ai

Employee IT support assistant with evidence-grounded troubleshooting, conversation memory and IT handoff.

## Repository contents

- `local-python/` contains the original Python/FastAPI RAG implementation and React frontend.
- `hosted-replit/` contains the hosted React/Express implementation exported from Replit.
- `submission/` contains the PowerPoint presentation and executive brief.

The hosted app uses Pinecone retrieval, Nebius generation, metadata filtering, multi-query RAG-Fusion and request correlation diagnostics. The two implementations have different backends and feature histories. Consult each implementation's documentation for setup.

Credentials, runtime databases, employee conversations, dependencies and caches are excluded. Configure provider credentials through the documented encrypted local vault or Replit Secrets.

Live application: https://vivacious-giving-bloatware.replit.app/
