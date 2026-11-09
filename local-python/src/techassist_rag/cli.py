import argparse
import json
import sys
from pathlib import Path
from .config import Settings
from .corpus import load_chunks


def parser():
    p = argparse.ArgumentParser(description='TechAssist: JSON corpus → recursive splitting → embeddings → Pinecone retrieval')
    sub = p.add_subparsers(dest='command', required=True)
    for name in ('validate', 'ingest'):
        cmd = sub.add_parser(name)
        cmd.add_argument('--file', type=Path, help='JSONL or JSON corpus (defaults to CORPUS_PATH)')
        if name == 'ingest':
            cmd.add_argument('--wait', action='store_true', help='Wait up to 60 seconds per group for ID visibility')
    cmd = sub.add_parser('secrets-store', help='Encrypt an API key locally; wrapping key stays in the OS credential manager')
    cmd.add_argument('provider', choices=['pinecone', 'openai', 'nebius'])
    sub.add_parser('init-index', help='Create or validate the configured Pinecone document index')
    for name in ('query', 'ask'):
        cmd = sub.add_parser(name)
        cmd.add_argument('question')
        cmd.add_argument('--top-k', type=int, default=5, help='Final number of reranked chunks (default 5)')
        cmd.add_argument('--candidate-k', type=int, help='Vector candidates to rerank (default RETRIEVAL_CANDIDATES=20)')
        cmd.add_argument('--category', choices=['hardware', 'software'])
        cmd.add_argument('--platform', help='Exact platform value from corpus metadata')
        cmd.add_argument('--min-score', type=float, help='Optional cosine cutoff; calibrate on evaluation data')
    cmd = sub.add_parser('evaluate', help='Measure retrieval recall@k and MRR on answerable questions')
    cmd.add_argument('--questions', type=Path, default=Path('knowledge_corpus/evaluation/retrieval_questions.jsonl'))
    cmd.add_argument('--top-k', type=int, default=5)
    cmd.add_argument('--candidate-k', type=int, help='Vector candidates before reranking')
    return p


def run(args, settings):
    if args.command == 'secrets-store':
        from .secrets import prompt_and_store
        path = prompt_and_store(settings.secrets_dir, args.provider)
        return {'provider': args.provider, 'encrypted_file': str(path), 'wrapping_key': 'OS credential manager'}
    chunks = None
    if args.command in ('validate', 'ingest'):
        chunks = load_chunks(args.file or settings.corpus, settings.chunk_tokens, settings.overlap)
        if args.command == 'validate':
            return {'documents': len({c.document_id for c in chunks}), 'chunks': len(chunks),
                    'chunk_strategy': 'recursive-token-v1',
                    'embedding_provider': settings.embedding_provider,
                    'embedding_model': settings.embedding_model, 'dimensions': settings.dimensions,
                    'provider_api_requests': 0}
    settings = settings.unlock_secrets(embeddings=args.command != 'init-index', generate=args.command == 'ask')
    settings.require_keys(embeddings=args.command != 'init-index', generate=args.command == 'ask')
    from pinecone import Pinecone
    from .pipeline import Store, Pipeline
    pc = Pinecone(api_key=settings.pinecone_key)
    embedder = client = None
    try:
        store = Store(pc, settings)
        if args.command == 'init-index':
            return store.initialize()
        from .embeddings import Embedder, PineconeEmbedder
        if settings.embedding_provider == 'openai' or args.command == 'ask':
            from openai import OpenAI
            client = OpenAI(api_key=settings.openai_key, timeout=60, max_retries=3)
        embedder = PineconeEmbedder(pc, settings) if settings.embedding_provider == 'pinecone' else Embedder(client, settings)
        pipeline = Pipeline(settings, embedder, store, client)
        if args.command == 'ingest':
            return pipeline.ingest(chunks, args.wait)
        if args.command in ('query', 'ask'):
            method = pipeline.retrieve if args.command == 'query' else pipeline.ask
            return method(args.question, top_k=args.top_k, category=args.category,
                          platform=args.platform, min_score=args.min_score, candidate_k=args.candidate_k)
        questions = [json.loads(line) for line in args.questions.read_text().splitlines() if line.strip()]
        if not questions or any(not q.get('expected_document_ids') for q in questions):
            raise ValueError('Evaluation needs non-empty expected_document_ids on every question.')
        recalls, reciprocals, details = [], [], []
        for q in questions:
            hits = pipeline.retrieve(q['question'], top_k=args.top_k, candidate_k=args.candidate_k)
            found = list(dict.fromkeys(hit['document_id'] for hit in hits))
            expected = set(q['expected_document_ids'])
            recalls.append(len(expected.intersection(found)) / len(expected))
            reciprocals.append(next((1 / rank for rank, doc in enumerate(found, 1) if doc in expected), 0))
            details.append({'id': q['id'], 'retrieved_document_ids': found, 'recall': recalls[-1]})
        return {'questions': len(questions), 'top_k': args.top_k,
                'candidate_k': args.candidate_k or settings.candidate_k, 'rerank_model': settings.rerank_model,
                'recall_at_k': sum(recalls) / len(recalls),
                'mean_reciprocal_rank': sum(reciprocals) / len(reciprocals), 'details': details}
    finally:
        if embedder:
            embedder.close()
        if client:
            client.close()
        pc.close()


def main():
    args = parser().parse_args()
    try:
        result = run(args, Settings.from_env())
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except (ValueError, OSError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1
    except Exception as exc:
        # SDK exception messages may include request details. Keep CLI failures private.
        print(f'Operation failed ({type(exc).__name__}). Check credentials, index/schema, connectivity and provider dashboard. '
              'Ingestion can be rerun safely; accepted batches are not rolled back.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
