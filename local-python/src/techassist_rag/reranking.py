"""Second-stage query/document relevance ranking using Pinecone Inference."""
import math


class Reranker:
    def __init__(self, pc, model='bge-reranker-v2-m3'):
        self.pc, self.model = pc, model

    def rerank(self, question, candidates, top_k=5):
        if not candidates:
            return []
        if any(not c.get('text', '').strip() for c in candidates):
            raise ValueError('Reranking candidates must contain non-empty text.')
        count = min(top_k, len(candidates))
        response = self.pc.inference.rerank(
            model=self.model, query=question,
            documents=[{'text': c['text']} for c in candidates],
            rank_fields=['text'], top_n=count, return_documents=False,
        )
        if len(response.data) != count:
            raise RuntimeError('Reranker returned an unexpected number of results.')
        seen, hits = set(), []
        for ranked in sorted(response.data, key=lambda item: item.score, reverse=True):
            i = ranked.index
            if not isinstance(i, int) or not 0 <= i < len(candidates) or i in seen or not math.isfinite(ranked.score):
                raise RuntimeError('Reranker returned invalid candidate indices or scores.')
            seen.add(i)
            # Map by the original input index, never by the reranked position.
            hits.append({**candidates[i], 'similarity_rank': i + 1,
                         'rerank_score': ranked.score, 'rerank_rank': len(hits) + 1,
                         'rerank_model': response.model})
        return hits
