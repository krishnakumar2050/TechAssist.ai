# TechAssist.ai

Employee IT support assistant with evidence-grounded troubleshooting, conversation memory and IT handoff.

## Project layout

- [Local Python project](local-python/README.md) contains the original Python/FastAPI backend and React frontend.
- `hosted-replit/` is reserved for the latest hosted React/Express source snapshot; export is in progress.
- [PowerPoint presentation](submission/TechAssist_Project_Submission.pptx)
- [Executive brief](submission/TechAssist_Executive_Brief.docx)

The hosted app uses Pinecone retrieval, Nebius generation, metadata filtering, multi-query RAG-Fusion and request correlation diagnostics. The local and hosted implementations have different backends and feature histories.

Credentials, runtime databases, employee conversations, dependencies and caches are excluded. Configure secrets through the documented encrypted local vault or Replit Secrets.

Live application: https://vivacious-giving-bloatware.replit.app/
