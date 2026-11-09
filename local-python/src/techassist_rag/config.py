from dataclasses import dataclass, field, replace
import os
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    openai_key: str = field(default='', repr=False)
    pinecone_key: str = field(default='', repr=False)
    index: str = 'techassist-laptops-hybrid'
    namespace: str = 'laptop-corpus-recursive-v2'
    cloud: str = 'aws'
    region: str = 'us-east-1'
    embedding_provider: str = 'pinecone'
    embedding_model: str = 'llama-text-embed-v2'
    dimensions: int = 1024
    chat_model: str = 'gpt-4.1-mini'
    rerank_model: str = 'bge-reranker-v2-m3'
    candidate_k: int = 20
    corpus: Path = Path('knowledge_corpus/rag_chunks.jsonl')
    chunk_tokens: int = 700
    overlap: int = 100
    batch_size: int = 32
    cache: Path = Path('.rag_cache/embeddings.sqlite3')
    secrets_dir: Path = Path('.secrets')

    @classmethod
    def from_env(cls):
        from dotenv import dotenv_values
        values = dotenv_values(Path.cwd() / '.env')
        if values.get('PINECONE_API_KEY'):
            raise ValueError('Remove plaintext PINECONE_API_KEY from .env; use techassist secrets-store pinecone.')
        if values.get('OPENAI_API_KEY'):
            raise ValueError('Remove plaintext OPENAI_API_KEY from .env; use techassist secrets-store openai.')
        def setting(name, default=''):
            return os.environ.get(name, values.get(name) or default)
        s = cls(
            openai_key=os.environ.get('OPENAI_API_KEY', ''),
            pinecone_key='',
            index=setting('PINECONE_INDEX', 'techassist-laptops-hybrid'),
            namespace=setting('PINECONE_NAMESPACE', 'laptop-corpus-recursive-v2'),
            cloud=setting('PINECONE_CLOUD', 'aws'),
            region=setting('PINECONE_REGION', 'us-east-1'),
            embedding_provider=setting('EMBEDDING_PROVIDER', 'pinecone'),
            embedding_model=setting('EMBEDDING_MODEL', 'llama-text-embed-v2'),
            dimensions=int(setting('EMBEDDING_DIMENSIONS', '1024')),
            chat_model=setting('CHAT_MODEL', 'gpt-4.1-mini'),
            rerank_model=setting('RERANK_MODEL', 'bge-reranker-v2-m3'),
            candidate_k=int(setting('RETRIEVAL_CANDIDATES', '20')),
            corpus=Path(setting('CORPUS_PATH', 'knowledge_corpus/rag_chunks.jsonl')),
            chunk_tokens=int(setting('CHUNK_TOKENS', '700')),
            overlap=int(setting('CHUNK_OVERLAP', '100')),
            batch_size=int(setting('BATCH_SIZE', '32')),
            secrets_dir=Path(setting('SECRETS_DIR', '.secrets')),
        )
        s.validate()
        return s

    def validate(self):
        if self.embedding_provider == 'pinecone':
            if self.embedding_model != 'llama-text-embed-v2' or self.dimensions not in (384, 512, 768, 1024, 2048):
                raise ValueError('Pinecone backend requires llama-text-embed-v2 and dimensions 384, 512, 768, 1024 or 2048.')
        elif self.embedding_provider == 'openai':
            maximum = {'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072}
            if self.embedding_model not in maximum or not 1 <= self.dimensions <= maximum[self.embedding_model]:
                raise ValueError('Invalid OpenAI embedding model or dimensions.')
        else:
            raise ValueError('EMBEDDING_PROVIDER must be pinecone or openai.')
        if not 32 <= self.chunk_tokens <= 2000 or not 0 <= self.overlap < self.chunk_tokens:
            raise ValueError('Require 32 <= CHUNK_TOKENS <= 2000 and 0 <= CHUNK_OVERLAP < CHUNK_TOKENS.')
        if not 1 <= self.batch_size <= 32:
            raise ValueError('BATCH_SIZE must be between 1 and 32.')
        if not 5 <= self.candidate_k <= 100 or not self.rerank_model.strip():
            raise ValueError('RETRIEVAL_CANDIDATES must be between 5 and 100; RERANK_MODEL must not be empty.')
        if not self.namespace.strip():
            raise ValueError('PINECONE_NAMESPACE must not be empty.')

    def unlock_secrets(self, embeddings=True, generate=False):
        from .secrets import load_secret
        return replace(self,
            pinecone_key=load_secret(self.secrets_dir, 'pinecone'),
            openai_key=(self.openai_key or load_secret(self.secrets_dir, 'openai')) if (generate or (embeddings and self.embedding_provider == 'openai')) else '',
        )

    def require_keys(self, embeddings=True, generate=False):
        if not self.pinecone_key.strip():
            raise ValueError('Store the Pinecone key with techassist secrets-store pinecone (encrypted project file + OS keyring).')
        if (generate or (embeddings and self.embedding_provider == 'openai')) and not self.openai_key.strip():
            raise ValueError('Store OPENAI_API_KEY with techassist secrets-store openai, or supply it through the process environment.')
