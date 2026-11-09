"""Run live sample queries and save the five reranked chunks for inspection."""
import json
from pathlib import Path
import time
from techassist_rag.cli import parser, run
from techassist_rag.config import Settings


def main():
    settings = Settings.from_env()
    samples = [json.loads(line) for line in Path('knowledge_corpus/evaluation/sample_user_queries.jsonl').read_text().splitlines() if line.strip()]
    results = []
    for sample in samples:
        started = time.monotonic()
        hits = run(parser().parse_args(['query', sample['question'], '--candidate-k', '20', '--top-k', '5']), settings)
        expected = set(sample['expected_document_ids'])
        found = [hit['document_id'] for hit in hits]
        entry = {**sample, 'elapsed_seconds': round(time.monotonic() - started, 2),
                 'expected_in_top_1': found[0] in expected if expected and found else (False if expected else None),
                 'expected_in_top_5': bool(expected.intersection(found)) if expected else None,
                 'results': hits}
        results.append(entry)
        print(json.dumps({'id': sample['id'], 'expected_in_top_1': entry['expected_in_top_1'],
                          'expected_in_top_5': entry['expected_in_top_5'],
                          'top_results': [{'title': h['title'], 'rerank_score': h['rerank_score']} for h in hits[:3]]}), flush=True)
    answerable = [r for r in results if r['expected_document_ids']]
    report = {'index': settings.index, 'namespace': settings.namespace,
              'candidate_k': 20, 'final_k': 5, 'rerank_model': settings.rerank_model,
              'answerable_samples': len(answerable),
              'top_1_matches': sum(r['expected_in_top_1'] for r in answerable),
              'top_5_matches': sum(r['expected_in_top_5'] for r in answerable),
              'note': 'Small manually selected smoke test, not an independent benchmark. No generated answers are tested.',
              'queries': results}
    path = Path('reports/sample_query_results.json')
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(report, indent=2))
    print(f"Saved {path}; top-1 {report['top_1_matches']}/{len(answerable)}, top-5 {report['top_5_matches']}/{len(answerable)}", flush=True)


if __name__ == '__main__':
    main()
