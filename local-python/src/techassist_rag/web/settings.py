from dataclasses import dataclass, field
import os
import json
from pathlib import Path
from dotenv import dotenv_values


@dataclass
class AppSettings:
    database_url: str = field(default='sqlite:///.app/techassist.db', repr=False)
    auth_mode: str = 'local'
    secure_cookies: bool = False
    origin: str = 'http://127.0.0.1:8000'
    response_mode: str = 'guided'
    nebius_model: str = 'Qwen/Qwen3-30B-A3B-Instruct-2507'
    ollama_url: str = 'http://127.0.0.1:11434'
    ollama_model: str = 'qwen2.5:3b'
    relevance_threshold: float = .03
    max_attempts: int = 6
    max_turns: int = 30
    oidc_metadata_url: str = ''
    oidc_client_id: str = ''
    oidc_client_secret: str = field(default='', repr=False)
    oidc_state_secret: str = field(default='', repr=False)

    @classmethod
    def from_env(cls):
        v = dotenv_values(Path.cwd() / '.env')
        def get(k, default=''):
            return os.environ.get(k, v.get(k) or default)
        default_db = 'sqlite:///.app/techassist.db'
        default_model = 'qwen2.5:3b'
        if Path('.app/services.json').exists():
            default_model = json.loads(Path('.app/services.json').read_text()).get('model', default_model)
            default_db = 'postgresql+psycopg://techassist:{password}@127.0.0.1:54329/techassist'
        database_url = get('DATABASE_URL', default_db)
        if '{password}' in database_url:
            from ..secrets import load_secret
            password = load_secret(Path(get('SECRETS_DIR', '.secrets')), 'database')
            if not password:
                raise ValueError('Provision the encrypted database credential with scripts/start_services.py.')
            database_url = database_url.replace('{password}', password)
        s = cls(database_url=database_url,
                auth_mode=get('AUTH_MODE', 'local'), secure_cookies=get('COOKIE_SECURE', 'false').lower() == 'true',
                origin=get('APP_ORIGIN', 'http://127.0.0.1:8000').rstrip('/'),
                response_mode=get('RESPONSE_MODE', 'guided'), ollama_url=get('OLLAMA_URL', 'http://127.0.0.1:11434').rstrip('/'),
                nebius_model=get('NEBIUS_MODEL', 'Qwen/Qwen3-30B-A3B-Instruct-2507'),
                ollama_model=get('OLLAMA_MODEL', default_model),
                relevance_threshold=float(get('RELEVANCE_THRESHOLD', '.03')),
                oidc_metadata_url=get('OIDC_METADATA_URL'), oidc_client_id=get('OIDC_CLIENT_ID'),
                oidc_client_secret=os.environ.get('OIDC_CLIENT_SECRET', ''),
                oidc_state_secret=os.environ.get('OIDC_STATE_SECRET', ''))
        if s.auth_mode not in ('local', 'oidc') or s.response_mode not in ('guided', 'ollama', 'nebius'):
            raise ValueError('Invalid AUTH_MODE or RESPONSE_MODE.')
        if s.auth_mode == 'oidc' and (not s.oidc_metadata_url.startswith('https://') or not s.oidc_client_id or not s.oidc_client_secret or not s.secure_cookies or not s.oidc_state_secret):
            raise ValueError('OIDC needs HTTPS metadata, client ID, process-environment client secret, OIDC_STATE_SECRET, and COOKIE_SECURE=true.')
        if not 0 <= s.relevance_threshold <= 1:
            raise ValueError('RELEVANCE_THRESHOLD must be between 0 and 1.')
        return s
