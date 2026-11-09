import json
from pathlib import Path
import pytest
import tiktoken
from techassist_rag.corpus import load_chunks


def write(tmp_path, rows, suffix='.jsonl'):
    path = tmp_path / ('corpus' + suffix)
    path.write_text(json.dumps(rows) if suffix == '.json' else '\n'.join(json.dumps(r) for r in rows))
    return path


def test_actual_corpus_has_33_topics_and_sources():
    chunks = load_chunks(Path('knowledge_corpus/rag_chunks.jsonl'))
    assert len(chunks) == 33
    assert all(c.metadata['source_urls'] for c in chunks)
    assert len({c.id for c in chunks}) == 33


def test_both_corpus_formats_are_supported():
    a = load_chunks(Path('knowledge_corpus/rag_chunks.jsonl'))
    b = load_chunks(Path('knowledge_corpus/laptop_knowledge.jsonl'))
    assert [c.text for c in a] == [c.text for c in b]
    assert all(c.metadata['source_urls'] for c in b)


def test_long_text_splits_with_overlap_and_stable_ids(tmp_path):
    path = write(tmp_path, [{'id': 'long', 'text': 'diagnostic step ' * 100, 'metadata': {'platform': 'Windows 11'}}])
    first = load_chunks(path, size=32, overlap=8)
    second = load_chunks(path, size=32, overlap=8)
    assert [c.id for c in first] == [c.id for c in second]
    enc = tiktoken.get_encoding('cl100k_base')
    tokens = [enc.encode(c.text) for c in first]
    assert len(first) > 1
    # Recursive overlap respects natural boundaries, so it is not an exact token window.
    assert first[0].text.split()[-2:] == first[1].text.split()[:2]
    assert all(c.metadata['chunk_strategy'] == 'recursive-token-v1' for c in first)
    assert all(len(t) <= 32 for t in tokens)
    assert all(c.document_id == 'long' for c in first)


@pytest.mark.parametrize('rows', [
    [{'id': 'x', 'text': ''}],
    [{'id': 'x', 'text': 'ok'}, {'id': 'x', 'text': 'other'}],
    [{'id': 'x', 'text': 'ok', 'metadata': {'nested': {'a': 1}}}],
    [{'id': 'x', 'text': 'ok', 'metadata': {'source_urls': 'not a list'}}],
    [{'id': 10, 'text': 'ok'}], [],
])
def test_invalid_records_rejected_before_network(tmp_path, rows):
    with pytest.raises(ValueError):
        load_chunks(write(tmp_path, rows))


def test_json_array(tmp_path):
    assert load_chunks(write(tmp_path, [{'id': 'a', 'text': 'hello'}], '.json'))[0].text == 'hello'


def test_recursive_split_prefers_paragraph_boundaries(tmp_path):
    a = 'Hardware diagnostics and resolution. ' * 4
    b = 'Software diagnostics and resolution. ' * 4
    path = write(tmp_path, [{'id': 'sections', 'text': a + '\n\n' + b}])
    chunks = load_chunks(path, size=35, overlap=0)
    assert len(chunks) == 2
    assert chunks[0].text == a
    assert chunks[1].text == '\n\n' + b


def test_recursive_split_preserves_unicode_without_replacement(tmp_path):
    text = '电脑维修 🔋 電池診断 café. ' * 100
    path = write(tmp_path, [{'id': 'unicode', 'text': text}])
    chunks = load_chunks(path, size=32, overlap=4)
    assert all('\ufffd' not in c.text for c in chunks)
    enc = tiktoken.get_encoding('cl100k_base')
    assert all(len(enc.encode(c.text)) <= 32 for c in chunks)
