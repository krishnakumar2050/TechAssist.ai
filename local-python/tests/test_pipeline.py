from dataclasses import replace
from types import SimpleNamespace as NS
from unittest.mock import MagicMock
import json
import pytest
from techassist_rag.config import Settings
from techassist_rag.corpus import Chunk
from techassist_rag.embeddings import Embedder
from techassist_rag.pipeline import Store, Pipeline, validate_index


def settings(tmp_path):
    return Settings(embedding_provider='openai', embedding_model='text-embedding-3-small', dimensions=3, cache=tmp_path / 'cache.sqlite3', batch_size=2)


def schema(dimensions=3):
    return {'schema': {'fields': {'embedding': {'type': 'dense_vector', 'dimension': dimensions, 'metric': 'cosine'}}}, 'status': {'ready': True}}


def embedding_client():
    client = MagicMock()
    client.embeddings.create.side_effect = lambda **kw: NS(data=[NS(index=i, embedding=[float(i), 1., 2.]) for i, _ in enumerate(kw['input'])][::-1])
    return client


def test_embedding_cache_orders_results_and_resumes(tmp_path):
    s, client = settings(tmp_path), embedding_client()
    e = Embedder(client, s)
    assert e.embed(['first', 'second', 'first']) == [[0., 1., 2.], [1., 1., 2.], [0., 1., 2.]]
    assert client.embeddings.create.call_count == 1
    e.close()
    e = Embedder(client, s)
    e.embed(['first', 'second'])
    assert client.embeddings.create.call_count == 1
    e.close()
    e = Embedder(client, replace(s, embedding_model='text-embedding-3-large'))
    e.embed(['first'])
    assert client.embeddings.create.call_count == 2
    e.close()


def test_embedding_bad_dimensions_rejected(tmp_path):
    client = MagicMock()
    client.embeddings.create.return_value = NS(data=[NS(index=0, embedding=[1.])])
    e = Embedder(client, settings(tmp_path))
    with pytest.raises(RuntimeError, match='dimensions'):
        e.embed(['hello'])
    e.close()


def test_index_validation_rejects_legacy_and_dimension_mismatch(tmp_path):
    s = settings(tmp_path)
    validate_index(schema(), s)
    with pytest.raises(ValueError, match='document index'):
        validate_index({'dimension': 3, 'metric': 'cosine'}, s)
    with pytest.raises(ValueError, match='DIMENSIONS'):
        validate_index(schema(10), s)


def test_store_uses_same_namespace_and_filters_embedding_contract(tmp_path):
    s, pc = settings(tmp_path), MagicMock()
    pc.indexes.describe.return_value = schema()
    index = pc.index.return_value
    index.documents.upsert.return_value = NS(upserted_count=1)
    index.documents.search.return_value = NS(matches=[])
    store = Store(pc, s)
    chunk = Chunk('id', 'doc', 'hello', {'source_urls': ['https://example.com']})
    assert store.upsert([chunk], [[1., 2., 3.]]) == 1
    payload = index.documents.upsert.call_args.kwargs
    assert payload['namespace'] == s.namespace
    assert payload['documents'][0]['text'] == 'hello'
    assert payload['documents'][0]['_id'] == 'id'
    store.search([1., 2., 3.], category='hardware', platform='Windows 11')
    query = index.documents.search.call_args.kwargs
    assert query['namespace'] == s.namespace
    assert {'embedding_model': {'$eq': s.embedding_model}} in query['filter']['$and']
    assert {'platform': {'$eq': 'Windows 11'}} in query['filter']['$and']


def test_partial_upsert_not_reported_as_success(tmp_path):
    pc = MagicMock()
    pc.indexes.describe.return_value = schema()
    pc.index.return_value.documents.upsert.return_value = NS(upserted_count=0)
    with pytest.raises(RuntimeError, match='acknowledge'):
        Store(pc, settings(tmp_path)).upsert([Chunk('x', 'x', 'hello', {})], [[1., 2., 3.]])


def test_generation_receives_evidence_and_no_hit_abstains(tmp_path):
    client, store, embedder = MagicMock(), MagicMock(), MagicMock()
    embedder.embed.return_value = [[1., 2., 3.]]
    store.search.return_value = []
    reranker = MagicMock()
    reranker.rerank.side_effect = lambda q, candidates, k: candidates[:k]
    p = Pipeline(settings(tmp_path), embedder, store, client, reranker=reranker)
    assert p.ask('battery issue')['sources'] == []
    client.responses.create.assert_not_called()
    store.search.return_value = [{'id': 'a', 'document_id': 'a', 'score': .9, 'text': 'Stop using a swollen battery.', 'source_urls': ['https://example.com']}]
    client.responses.create.return_value = NS(output_text='Stop use. [1]')
    answer = p.ask('battery issue')
    assert answer['answer'] == 'Stop use. [1]'
    sent = json.loads(client.responses.create.call_args.kwargs['input'])
    assert sent['retrieved_evidence'][0]['label'] == 1
    assert answer['sources'][0]['source_urls'] == ['https://example.com']


def test_ingest_batches_and_stable_ids_on_rerun(tmp_path):
    store, e = MagicMock(), MagicMock()
    e.embed.side_effect = lambda texts, **kw: [[1., 2., 3.] for _ in texts]
    store.upsert.side_effect = lambda chunks, vectors: len(chunks)
    p = Pipeline(settings(tmp_path), e, store)
    chunks = [Chunk(str(i), str(i), 'hello', {}) for i in range(3)]
    assert p.ingest(chunks)['upserted'] == 3
    assert store.upsert.call_count == 2
    p.ingest(chunks)
    assert [c.id for c in store.upsert.call_args_list[0].args[0]] == ['0', '1']
    assert [c.id for c in store.upsert.call_args_list[2].args[0]] == ['0', '1']


def test_missing_keys_and_invalid_configuration():
    with pytest.raises(ValueError, match='secrets-store pinecone'):
        Settings().require_keys()
    with pytest.raises(ValueError, match='OPENAI_API_KEY'):
        Settings(pinecone_key='test-only', embedding_provider='openai').require_keys()
    with pytest.raises(ValueError):
        Settings(overlap=700).validate()


def test_initialize_creates_only_when_missing(tmp_path):
    from pinecone import NotFoundError
    pc = MagicMock()
    pc.indexes.describe.side_effect = [NotFoundError(), schema()]
    result = Store(pc, settings(tmp_path)).initialize()
    assert result['ready']
    payload = pc.indexes.create.call_args.kwargs
    assert payload['schema']['fields']['embedding']['dimension'] == 3
    assert payload['deletion_protection'] == 'enabled'
    assert payload['timeout'] == 120


def test_initialize_reuses_existing_index(tmp_path):
    pc = MagicMock()
    pc.indexes.describe.return_value = schema()
    Store(pc, settings(tmp_path)).initialize()
    pc.indexes.create.assert_not_called()


def test_wait_visibility_has_a_timeout(tmp_path):
    pc = MagicMock()
    pc.indexes.describe.return_value = schema()
    pc.index.return_value.documents.fetch.return_value = NS(documents={})
    with pytest.raises(TimeoutError):
        Store(pc, settings(tmp_path)).wait_visible(['missing'], timeout=0)


def test_pinecone_embedding_passage_and_query_caches_are_separate(tmp_path):
    from techassist_rag.embeddings import PineconeEmbedder
    client = MagicMock()
    s = replace(Settings(), dimensions=3, cache=tmp_path / 'cache.sqlite3')
    client.inference.embed.side_effect = lambda **kw: NS(
        model=s.embedding_model, vector_type='dense',
        data=[NS(values=[1., 2., 3.]) for _ in kw['inputs']])
    e = PineconeEmbedder(client, s)
    e.embed(['same text'])
    e.embed(['same text'])
    e.embed(['same text'], input_type='query')
    assert client.inference.embed.call_count == 2
    params = [call.kwargs['parameters'] for call in client.inference.embed.call_args_list]
    assert [p['input_type'] for p in params] == ['passage', 'query']
    assert all(p['truncate'] == 'NONE' and p['dimension'] == 3 for p in params)
    e.close()


def test_pinecone_backend_does_not_require_openai_key():
    Settings(pinecone_key='test-value').require_keys()
    with pytest.raises(ValueError, match='OPENAI_API_KEY'):
        Settings(pinecone_key='test-value').require_keys(generate=True)
