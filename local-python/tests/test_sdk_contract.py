"""Exercise real SDK serialization/parsing with HTTP replaced in memory."""
from dataclasses import replace
from types import SimpleNamespace as NS
import json
import httpx
from pinecone import Pinecone
from openai import OpenAI
from techassist_rag.config import Settings
from techassist_rag.corpus import Chunk
from techassist_rag.embeddings import Embedder
from techassist_rag.pipeline import Store, Pipeline


def test_real_sdks_ingest_and_retrieve_without_network(monkeypatch, tmp_path):
    requests = []
    stored = {}

    def send(self, request, **kwargs):
        body = json.loads(request.content) if request.content else {}
        requests.append((request.url.host, request.url.path, body))
        path = request.url.path
        if path == '/indexes/techassist-laptops':
            result = {'name': 'techassist-laptops', 'host': 'offline.svc.pinecone.io',
                'status': {'ready': True, 'state': 'Ready'},
                'schema': {'fields': {'embedding': {'type': 'dense_vector', 'dimension': 3, 'metric': 'cosine'}}},
                'deployment': {'deployment_type': 'managed', 'cloud': 'aws', 'region': 'us-east-1'},
                'deletion_protection': 'enabled'}
        elif path == '/v1/embeddings':
            result = {'object': 'list', 'model': 'text-embedding-3-small', 'usage': {'prompt_tokens': 4, 'total_tokens': 4},
                'data': [{'object': 'embedding', 'index': i, 'embedding': [1., 2., 3.]} for i in range(len(body['input']))]}
        elif path.endswith('/upsert'):
            for record in body['documents']:
                stored[record['_id']] = record
            result = {'upserted_count': len(body['documents'])}
        elif path == '/rerank':
            assert body['top_n'] == 1
            result = {'model': 'bge-reranker-v2-m3', 'data': [{'index': 0, 'score': .8}], 'usage': {'rerank_units': 1}}
        elif path.endswith('/search'):
            doc = dict(next(iter(stored.values())))
            doc['_score'] = .95
            result = {'matches': [doc], 'namespace': 'laptop-corpus-recursive-v2', 'usage': {'read_units': 1}}
        else:
            raise AssertionError(f'Unexpected request: {request.url}')
        return httpx.Response(200, json=result, request=request)

    monkeypatch.setattr(httpx.Client, 'send', send)
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', send)
    s = replace(Settings(), index='techassist-laptops', embedding_provider='openai', embedding_model='text-embedding-3-small', dimensions=3, cache=tmp_path/'cache.sqlite3')
    pc = Pinecone(api_key='offline-test-key')
    client = OpenAI(api_key='offline-test-key')
    embedder = Embedder(client, s)
    try:
        pipeline = Pipeline(s, embedder, Store(pc, s), client)
        result = pipeline.ingest([Chunk('one', 'doc-one', 'Battery troubleshooting', {'source_urls': ['https://example.com']})])
        assert result['upserted'] == 1
        hits = pipeline.retrieve('Battery troubleshooting')
        assert hits[0]['document_id'] == 'doc-one'
        assert hits[0]['score'] == .95
        assert hits[0]['rerank_score'] == .8
        assert any(r[1] == '/rerank' for r in requests)
        assert hits[0]['source_urls'] == ['https://example.com']
        assert len([r for r in requests if r[1] == '/v1/embeddings']) == 1
        assert any(s.namespace in path for _, path, _ in requests if path.endswith('/search'))
    finally:
        embedder.close()
        client.close()
        pc.close()


def test_real_pinecone_inference_sdk_without_openai(monkeypatch, tmp_path):
    from techassist_rag.embeddings import PineconeEmbedder
    requests = []

    def send(self, request, **kwargs):
        body = json.loads(request.content)
        requests.append(body)
        assert request.url.path == '/embed'
        assert body['model'] == 'llama-text-embed-v2'
        data = {'model': 'llama-text-embed-v2', 'vector_type': 'dense',
                'data': [{'values': [1., 2., 3.]}], 'usage': {'total_tokens': 3}}
        return httpx.Response(200, json=data, request=request)

    monkeypatch.setattr(httpx.Client, 'send', send)
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', send)
    s = replace(Settings(), dimensions=3, cache=tmp_path / 'cache.sqlite3')
    pc = Pinecone(api_key='offline-test-key')
    e = PineconeEmbedder(pc, s)
    try:
        assert e.embed(['battery']) == [[1., 2., 3.]]
        assert e.embed(['battery'], input_type='query') == [[1., 2., 3.]]
        assert requests[0]['parameters']['input_type'] == 'passage'
        assert requests[1]['parameters']['input_type'] == 'query'
    finally:
        e.close()
        pc.close()
