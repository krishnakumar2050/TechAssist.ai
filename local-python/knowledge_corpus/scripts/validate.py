"""Check corpus references, metadata and package integrity; no network calls."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
def read_jsonl(name):
    return [json.loads(line) for line in (root / name).read_text().splitlines() if line.strip()]

docs = read_jsonl('laptop_knowledge.jsonl')
chunks = read_jsonl('rag_chunks.jsonl')
sources = json.loads((root / 'sources.json').read_text())
manifest = json.loads((root / 'manifest.json').read_text())
ids = {d['id'] for d in docs}
source_ids = {s['id'] for s in sources}
assert len(ids) == len(docs) == manifest['documents']
assert len({c['id'] for c in chunks}) == len(chunks) == manifest['chunks']
assert len(source_ids) == len(sources) == manifest['sources']
assert {c['document_id'] for c in chunks} == ids
for d in docs:
    assert d['text'] and d['resolution_steps'] and d['verification'] and d['escalation']
    assert set(d['source_ids']) <= source_ids
    assert all(url.startswith('https://') for url in d['source_urls'])
    assert (root / 'articles' / (d['id'] + '.md')).is_file()
for name in ['evaluation/retrieval_questions.jsonl', 'evaluation/boundary_questions.jsonl']:
    for q in read_jsonl(name):
        assert set(q.get('expected_document_ids', [])) <= ids, q['id']
for name, expected in manifest['files'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
print(f'PASS: {len(docs)} documents, {len(chunks)} chunks, {len(sources)} sources; references and checksums valid.')
