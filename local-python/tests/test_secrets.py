"""Use a memory-only keyring for tests; never access real credentials."""
import json
import os
from pathlib import Path
import pytest
from cryptography.fernet import Fernet
from techassist_rag.secrets import store_secret, load_secret, SecretError, secure_backend
from techassist_rag.config import Settings


class MemoryKeyring:
    def __init__(self):
        self.items = {}

    def get_password(self, service, username):
        return self.items.get((service, username))

    def set_password(self, service, username, value):
        self.items[(service, username)] = value


def test_encrypted_at_rest_and_unlocks_only_with_external_key(tmp_path):
    directory = tmp_path / '.secrets'
    backend = MemoryKeyring()
    sentinel = 'test-only-not-a-real-pinecone-credential'
    path = store_secret(directory, 'pinecone', sentinel, backend)
    assert load_secret(directory, 'pinecone', backend) == sentinel
    envelope = json.loads(path.read_text())
    assert set(envelope) == {'version', 'key_id', 'ciphertext'}
    for file in tmp_path.rglob('*'):
        if file.is_file():
            assert sentinel.encode() not in file.read_bytes()
            assert all(master.encode() not in file.read_bytes() for master in backend.items.values())
    if os.name != 'nt':
        assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(SecretError, match='missing'):
        load_secret(directory, 'pinecone', MemoryKeyring())


def test_ciphertext_tampering_is_rejected(tmp_path):
    backend = MemoryKeyring()
    path = store_secret(tmp_path, 'pinecone', 'test-only-value', backend)
    envelope = json.loads(path.read_text())
    token = envelope['ciphertext']
    envelope['ciphertext'] = token[:50] + ('A' if token[50] != 'A' else 'B') + token[51:]
    path.write_text(json.dumps(envelope))
    with pytest.raises(SecretError, match='authentication failed'):
        load_secret(tmp_path, 'pinecone', backend)


def test_provider_substitution_is_rejected(tmp_path):
    backend = MemoryKeyring()
    path = store_secret(tmp_path, 'pinecone', 'test-only-value', backend)
    (tmp_path / 'openai.enc').write_bytes(path.read_bytes())
    with pytest.raises(SecretError):
        load_secret(tmp_path, 'openai', backend)


def test_replacement_reuses_wrapping_key_and_updates_ciphertext(tmp_path):
    backend = MemoryKeyring()
    path = store_secret(tmp_path, 'pinecone', 'first-test-value', backend)
    before = path.read_bytes()
    store_secret(tmp_path, 'pinecone', 'second-test-value', backend)
    assert path.read_bytes() != before
    assert len(backend.items) == 1
    assert load_secret(tmp_path, 'pinecone', backend) == 'second-test-value'


def test_insecure_keyring_backend_fails_closed(monkeypatch):
    import keyring
    monkeypatch.setattr(keyring, 'get_keyring', lambda: MemoryKeyring())
    with pytest.raises(SecretError, match='No file-based fallback'):
        secure_backend()


@pytest.mark.parametrize('provider', ['pinecone', 'openai'])
def test_plaintext_dotenv_keys_are_rejected_without_leaking_value(tmp_path, monkeypatch, provider):
    monkeypatch.chdir(tmp_path)
    sentinel = 'test-value-never-print'
    (tmp_path / '.env').write_text(f'{provider.upper()}_API_KEY={sentinel}\n')
    with pytest.raises(ValueError) as exc:
        Settings.from_env()
    assert sentinel not in str(exc.value)


def test_settings_unlocks_only_at_cloud_operation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    backend = MemoryKeyring()
    store_secret(tmp_path / '.secrets', 'pinecone', 'test-pinecone-value', backend)
    store_secret(tmp_path / '.secrets', 'openai', 'test-openai-value', backend)
    monkeypatch.setattr('techassist_rag.secrets.secure_backend', lambda: backend)
    settings = Settings.from_env()
    assert settings.pinecone_key == ''
    unlocked = settings.unlock_secrets(generate=True)
    unlocked.require_keys()
    assert unlocked.pinecone_key == 'test-pinecone-value'
    assert 'test-pinecone-value' not in repr(unlocked)
    assert 'test-openai-value' not in repr(unlocked)
