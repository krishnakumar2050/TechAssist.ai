"""Cached embeddings from Pinecone Inference or optional OpenAI."""
import hashlib
import json
import math
import sqlite3


class Embedder:
    """OpenAI backend. Its embeddings are symmetric for passages and queries."""
    def __init__(self, client, settings):
        self.client, self.s = client, settings
        settings.cache.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(settings.cache)
        self.db.execute('CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector TEXT NOT NULL)')

    def _key(self, text, input_type):
        return hashlib.sha256(json.dumps([self.s.embedding_model, self.s.dimensions, text]).encode()).hexdigest()

    def _request(self, texts, input_type):
        response = self.client.embeddings.create(
            model=self.s.embedding_model, dimensions=self.s.dimensions, input=texts,
        )
        items = sorted(response.data, key=lambda item: item.index)
        if [item.index for item in items] != list(range(len(texts))):
            raise RuntimeError('Embedding response does not align with request.')
        return [item.embedding for item in items]

    def embed(self, texts, input_type='passage'):
        if input_type not in ('passage', 'query'):
            raise ValueError('input_type must be passage or query.')
        if not texts or any(not t.strip() for t in texts):
            raise ValueError('Embedding input must contain non-empty text.')
        keys = [self._key(t, input_type) for t in texts]
        vectors, missing = {}, {}
        for key, text in zip(keys, texts):
            row = self.db.execute('SELECT vector FROM embeddings WHERE key=?', (key,)).fetchone()
            if row:
                vectors[key] = json.loads(row[0])
            else:
                missing[key] = text
        pending = list(missing)
        for start in range(0, len(pending), self.s.batch_size):
            batch = pending[start:start + self.s.batch_size]
            values = self._request([missing[k] for k in batch], input_type)
            if len(values) != len(batch):
                raise RuntimeError('Embedding response count does not match request.')
            for key, vector in zip(batch, values):
                if len(vector) != self.s.dimensions or not all(math.isfinite(x) for x in vector):
                    raise RuntimeError('Invalid embedding dimensions or values.')
                vectors[key] = vector
                self.db.execute('INSERT OR REPLACE INTO embeddings VALUES (?, ?)', (key, json.dumps(vector)))
            self.db.commit()
        return [vectors[k] for k in keys]

    def close(self):
        self.db.close()


class PineconeEmbedder(Embedder):
    """Use the same encrypted Pinecone credential for inference and storage."""
    def _key(self, text, input_type):
        # Asymmetric models need distinct query and passage caches.
        payload = ['pinecone', self.s.embedding_model, self.s.dimensions, input_type, text]
        return hashlib.sha256(json.dumps(payload).encode()).hexdigest()

    def _request(self, texts, input_type):
        response = self.client.inference.embed(
            model=self.s.embedding_model, inputs=texts,
            parameters={'input_type': input_type, 'dimension': self.s.dimensions, 'truncate': 'NONE'},
        )
        if response.vector_type != 'dense' or response.model != self.s.embedding_model:
            raise RuntimeError('Unexpected Pinecone embedding model or vector type.')
        return [item.values for item in response.data]
