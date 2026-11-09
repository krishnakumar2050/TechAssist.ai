# TechAssist.ai laptop troubleshooting corpus

A starter knowledge source for a laptop support RAG pipeline. Contains 33 original concise topic summaries linked to 20 official Microsoft, Dell, Apple and Ubuntu support sources. Reviewed on 3 November 2026. These are editorial summaries, not real support tickets, manufacturer-authored articles, exhaustive repair procedures, or lab-tested resolutions.

## Files

- `rag_chunks.jsonl`: ready-to-embed records with `id`, `document_id`, `text` and `metadata`.
- `laptop_knowledge.jsonl`: structured topics with symptoms, possible causes, ordered resolution steps, verification, escalation, platform and source links.
- `articles/`: the same topics as individual Markdown documents for directory loaders.
- `sources.json`: source provenance and evidence-access limitations.
- `topic_index.csv`: browse topics in a spreadsheet.
- `evaluation/retrieval_questions.jsonl`: 33 synthetic answerable questions and expected document IDs.
- `evaluation/boundary_questions.jsonl`: six ambiguity, safety and knowledge-boundary checks.
- `scripts/validate.py`: dependency-free structural validation.
- `manifest.json`: counts and SHA-256 checksums.

Choose one corpus representation for ingestion. Loading JSONL and Markdown together would duplicate the same knowledge.

## Coverage

Hardware: memory upgrades, failed POST after damage, overheating, fan noise, battery swelling, charging, camera, external input devices and external displays.

Software: Wi-Fi, Bluetooth, Bluetooth audio, camera permissions, crashes, recovery, updates, storage space, malware, startup disks, filesystem repair, graphics drivers, audio and BitLocker.

Platform tags deliberately preserve scope. Dell procedures are not universal OEM procedures. Windows content targets Windows 11; macOS and Ubuntu records require the deployed version and model to be checked. Ubuntu coverage is limited to Wi-Fi. There are no detailed board repairs, universal blink-code tables, printer guides, browser repair guides or application-specific productivity guides in this version.

## RAG ingestion

RAG normally indexes knowledge for retrieval; it does not require training or fine-tuning the language model.

1. Read `rag_chunks.jsonl` and embed each record's `text` with your chosen embedding model.
2. Upsert vectors using the chunk `id`. Preserve all metadata and `document_id`.
3. Filter by known platform and device scope. Ask for missing model or OS details when they change the procedure.
4. Retrieve several candidates; use lexical matching as well as vectors for error codes and exact phrases. Tune candidate count on your own questions.
5. Supply retrieved text and source URLs to the answering model. Require citations, conditional diagnoses, ordered steps, verification and applicable escalation.
6. Keep evaluation files out of the retrieval index. Use expected IDs to measure recall@k and reciprocal rank, then assess answer grounding and safety separately.

The topics are intentionally short: one complete issue per chunk keeps the resolution and escalation together. If expanded later, split by issue and procedure rather than arbitrary character boundaries. Preserve model, OS, source, date and safety context in every resulting chunk.

Minimal loading example using only the Python standard library:

```python
import json
from pathlib import Path

records = [json.loads(line) for line in
           Path('knowledge_corpus/rag_chunks.jsonl').read_text().splitlines()]
texts = [record['text'] for record in records]
# vectors = embedding_client.embed(texts)
# vector_store.upsert(ids=..., vectors=..., metadata=...)
```

## Suggested answer instructions

Answer using applicable retrieved evidence. Ask for laptop model, operating system, exact symptom and recent changes when needed. Present causes as possibilities until verified. Try least disruptive applicable checks first. Include a verification step and escalation condition. Cite the retrieved source URLs. Do not invent key sequences, universal diagnostic codes, commands, firmware procedures or unsupported resolutions. If evidence is insufficient, state the gap and request the missing details. Preserve battery safety instructions and data-loss warnings. Do not request passwords or recovery keys in chat. Managed devices should follow organization IT policies.

## Evidence quality and maintenance

Some pages were available only through search excerpts; some direct fetches were rate limited or failed. `sources.json` records this explicitly. A checked date describes evidence review, not a successful laboratory test or a guarantee that a URL remains accessible. Resolution and verification fields combine concise source-based summaries with editorial troubleshooting structure. The possible causes are hypotheses, not confirmed diagnoses.

Before production use, review procedures against exact supported models and OS releases, expand thin topics using full official articles, and have a technician validate the content. Recheck sources when support guidance or supported platforms change. Maintain stable document IDs; re-embed changed records and remove obsolete chunks. Do not index credentials, personal support-ticket data, or untrusted instructions as operational policy.

The corpus does not reproduce full support pages. Source content remains subject to its publisher's terms; no third-party redistribution or model-training license was verified. The included sample questions are synthetic smoke checks, not an independent benchmark. Build a separate held-out set of real, de-identified user questions before reporting quality metrics.

## Validate

From the project directory:

```bash
python3 knowledge_corpus/scripts/validate.py
```
