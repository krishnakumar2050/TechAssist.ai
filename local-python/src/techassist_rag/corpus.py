"""Normalize JSON/JSONL, validate metadata, and recursively split text using token limits."""
from dataclasses import dataclass
import json
import math
from pathlib import Path
from langchain_text_splitters import RecursiveCharacterTextSplitter


@dataclass
class Chunk:
    id: str
    document_id: str
    text: str
    metadata: dict


def clean_metadata(data):
    if not isinstance(data, dict):
        raise ValueError('Metadata must be an object.')
    result = {}
    for key, value in data.items():
        if value is None:
            continue
        if isinstance(value, (str, bool)):
            result[key] = value
        elif isinstance(value, (int, float)) and math.isfinite(value):
            result[key] = value
        elif isinstance(value, list) and all(isinstance(v, str) for v in value):
            result[key] = value
        else:
            raise ValueError(f'Metadata {key!r} must be scalar or a list of strings.')
    return result


def load_chunks(path: Path, size=700, overlap=100):
    if not 0 <= overlap < size:
        raise ValueError('Overlap must be smaller than chunk size.')
    content = path.read_text(encoding='utf-8')
    if path.suffix.lower() == '.json':
        rows = json.loads(content)
        if isinstance(rows, dict):
            rows = [rows]
    else:
        rows = [json.loads(line) for line in content.splitlines() if line.strip()]
    if not isinstance(rows, list) or not rows:
        raise ValueError('Corpus must contain at least one JSON object.')
    splitter = RecursiveCharacterTextSplitter.from_tiktoken_encoder(
        encoding_name='cl100k_base', chunk_size=size, chunk_overlap=overlap,
        separators=['\n\n', '\n', '. ', ' ', ''],
        keep_separator=True, strip_whitespace=False, disallowed_special=(),
    )
    chunks, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Each corpus record must be an object.')
        record_id, text = row.get('id'), row.get('text')
        if not isinstance(record_id, str) or not record_id.strip():
            raise ValueError('Each record needs a non-empty string id.')
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f'{record_id}: text must be non-empty.')
        doc_id = row.get('document_id', record_id)
        if not isinstance(doc_id, str) or not doc_id.strip():
            raise ValueError('document_id must be a non-empty string.')
        # Both the structured topic JSONL and ready-to-embed JSONL are supported.
        meta = row.get('metadata', {k: row[k] for k in (
            'title', 'category', 'subcategory', 'platform', 'source_urls',
            'source_ids', 'risk_level', 'reviewed_on', 'language') if k in row})
        meta = clean_metadata(meta)
        for key in ('source_urls', 'source_ids'):
            if key in meta and not isinstance(meta[key], list):
                raise ValueError(f'{key} must be a list of strings.')
        parts = splitter.split_text(text)
        for number, part in enumerate(parts):
            chunk_id = record_id if len(parts) == 1 else f'{record_id}::recursive-{number + 1:04d}'
            if chunk_id in seen:
                raise ValueError(f'Duplicate chunk ID: {chunk_id}')
            if len(chunk_id.encode()) > 512:
                raise ValueError('Chunk ID exceeds 512 bytes.')
            seen.add(chunk_id)
            chunks.append(Chunk(chunk_id, doc_id, part, {**meta, 'chunk_strategy': 'recursive-token-v1',
                'chunk_tokens': size, 'chunk_overlap': overlap, 'chunk_number': number + 1}))
    return chunks
