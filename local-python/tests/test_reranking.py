from types import SimpleNamespace as NS
from unittest.mock import MagicMock
import pytest
from techassist_rag.config import Settings
from techassist_rag.pipeline import Pipeline
from techassist_rag.reranking import Reranker


def candidates(count=20):
    return [dict(id=f'chunk-{i}', document_id=f'doc-{i}', text=f'Troubleshooting topic {i}',
                 score=1 - i / 100, source_urls=[f'https://example.com/{i}']) for i in range(count)]


def test_rerank_selects_five_by_relevance_and_preserves_correct_sources():
    pc = MagicMock()
    # Reranked order intentionally disagrees with similarity order.
    pc.inference.rerank.return_value = NS(model='served-model', data=[
        NS(index=i, score=score) for i, score in [(17, .99), (6, .95), (2, .9), (19, .8), (0, .7)]])
    hits = Reranker(pc).rerank('battery problem', candidates(), 5)
    assert [hit['id'] for hit in hits] == ['chunk-17', 'chunk-6', 'chunk-2', 'chunk-19', 'chunk-0']
    assert hits[0]['source_urls'] == ['https://example.com/17']
    assert hits[0]['score'] == .83
    assert hits[0]['rerank_score'] == .99
    assert hits[0]['rerank_model'] == 'served-model'
    assert hits[0]['similarity_rank'] == 18
    args = pc.inference.rerank.call_args.kwargs
    assert args['top_n'] == 5 and len(args['documents']) == 20
    assert args['query'] == 'battery problem'


def test_pipeline_retrieves_twenty_then_returns_five():
    store, embedder, reranker = MagicMock(), MagicMock(), MagicMock()
    store.search.return_value = candidates()
    embedder.embed.return_value = [[1.0]]
    reranker.rerank.side_effect = lambda q, hits, k: list(reversed(hits))[:k]
    p = Pipeline(Settings(), embedder, store, reranker=reranker)
    hits = p.retrieve('battery problem', category='hardware')
    store.search.assert_called_once_with([1.0], 20, 'hardware', None, question='battery problem')
    assert len(hits) == 5 and hits[0]['id'] == 'chunk-19'


def test_similarity_cutoff_is_applied_before_reranking():
    store, embedder, reranker = MagicMock(), MagicMock(), MagicMock()
    store.search.return_value = candidates(3)
    embedder.embed.return_value = [[1.0]]
    reranker.rerank.side_effect = lambda q, hits, k: hits[:k]
    p = Pipeline(Settings(), embedder, store, reranker=reranker)
    hits = p.retrieve('battery', min_score=.99)
    assert len(hits) == 2
    assert len(reranker.rerank.call_args.args[1]) == 2
    store.search.return_value = []
    reranker.reset_mock()
    assert p.retrieve('battery') == []
    reranker.rerank.assert_not_called()


@pytest.mark.parametrize('indices', [[0, 0], [0, 99]])
def test_invalid_response_mapping_fails_closed(indices):
    pc = MagicMock()
    pc.inference.rerank.return_value = NS(model='test', data=[NS(index=i, score=.8) for i in indices])
    with pytest.raises(RuntimeError, match='indices'):
        Reranker(pc).rerank('query', candidates(2), 5)


def test_short_candidate_set_returns_only_available_chunks():
    pc = MagicMock()
    pc.inference.rerank.return_value = NS(model='test', data=[NS(index=0, score=.8)])
    assert len(Reranker(pc).rerank('query', candidates(1), 5)) == 1
    assert pc.inference.rerank.call_args.kwargs['top_n'] == 1


def test_bad_candidate_count_rejected_before_provider_calls():
    embedder, store = MagicMock(), MagicMock()
    with pytest.raises(ValueError, match='candidate_k'):
        Pipeline(Settings(), embedder, store).retrieve('question', candidate_k=4)
    embedder.embed.assert_not_called()


def test_provider_failure_propagates_without_silent_similarity_fallback():
    pc = MagicMock()
    pc.inference.rerank.side_effect = RuntimeError('provider unavailable')
    with pytest.raises(RuntimeError, match='provider unavailable'):
        Reranker(pc).rerank('query', candidates(), 5)


def test_hybrid_fusion_keeps_keyword_only_matches_and_deduplicates():
    from techassist_rag.pipeline import Store

    def match(chunk_id, score):
        return NS(id=chunk_id, score=score, get={'text': chunk_id}.get)

    pc = MagicMock()
    store = Store(pc, Settings())
    store._index = MagicMock()
    store._full_text = True
    search = store._index.documents.search
    search.side_effect = [
        NS(matches=[match('dense', .9), match('shared', .8)]),
        NS(matches=[match('keyword', 12), match('shared', 5)]),
    ]
    hits = store.search([1.0], 3, category='software', question='0xC1900101')
    assert [hit['id'] for hit in hits] == ['shared', 'dense', 'keyword']
    assert hits[0]['score'] == .8
    assert hits[2]['score'] is None and hits[2]['keyword_score'] == 12
    assert search.call_args_list[0].kwargs['filter'] == search.call_args_list[1].kwargs['filter']


def test_query_expansion_preserves_original_for_keywords_and_reranking():
    store, embedder, reranker = MagicMock(), MagicMock(), MagicMock()
    embedder.embed.return_value = [[1.0]]
    store.search.return_value = candidates(1)
    question = 'BSOD on Windows 11 with 0x0000007E. No recent updates.'
    Pipeline(Settings(), embedder, store, reranker=reranker).retrieve(question)
    enhanced = embedder.embed.call_args.args[0][0]
    assert enhanced.startswith(question)
    assert 'blue screen stop error' in enhanced
    assert store.search.call_args.kwargs['question'] == question
    assert reranker.rerank.call_args.args[0] == question
