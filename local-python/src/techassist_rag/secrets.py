"""Authenticated encrypted project credentials; wrapping keys live only in OS keyring."""
import getpass
import json
import os
from pathlib import Path
import tempfile
import uuid
from cryptography.fernet import Fernet, InvalidToken

SERVICE = 'techassist-rag-vault-v1'
PROVIDERS = ('pinecone', 'openai', 'database', 'nebius')


class SecretError(ValueError):
    """Sanitized credential storage failure."""


def secure_backend():
    import keyring
    backend = keyring.get_keyring()
    # Fail closed: never use keyrings.alt plaintext/encrypted files or a chainer
    # whose selected backend could silently change to a file implementation.
    allowed = ('keyring.backends.macOS', 'keyring.backends.Windows',
               'keyring.backends.SecretService', 'keyring.backends.kwallet')
    if type(backend).__module__ not in allowed:
        raise SecretError('A supported OS credential manager is required (macOS Keychain, Windows Credential Locker, Secret Service or KWallet). No file-based fallback is allowed.')
    return backend


def credential_path(directory, provider):
    if provider not in PROVIDERS:
        raise SecretError('Unsupported credential provider.')
    return Path(directory) / f'{provider}.enc'


def _read_envelope(path):
    try:
        envelope = json.loads(path.read_text(encoding='utf-8'))
        if envelope['version'] != 1 or not isinstance(envelope['ciphertext'], str):
            raise ValueError()
        uuid.UUID(envelope['key_id'])
        return envelope
    except (ValueError, KeyError, TypeError, OSError):
        raise SecretError('Encrypted credential file is missing, malformed or unreadable.') from None


def store_secret(directory, provider, value, backend=None):
    if not isinstance(value, str) or not value.strip() or any(c.isspace() for c in value.strip()):
        raise SecretError('API key must be a non-empty value without whitespace.')
    path = credential_path(directory, provider)
    backend = backend or secure_backend()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    envelope = _read_envelope(path) if path.exists() else {'version': 1, 'key_id': str(uuid.uuid4())}
    try:
        master = backend.get_password(SERVICE, envelope['key_id'])
        if path.exists() and not master:
            raise SecretError('OS keyring wrapping key is missing. Restore keyring access before replacing this credential.')
        if not master:
            master = Fernet.generate_key().decode('ascii')
            backend.set_password(SERVICE, envelope['key_id'], master)
            if backend.get_password(SERVICE, envelope['key_id']) != master:
                raise SecretError('OS keyring did not retain the wrapping key.')
        payload = json.dumps({'provider': provider, 'api_key': value.strip()}).encode('utf-8')
        envelope['ciphertext'] = Fernet(master.encode('ascii')).encrypt(payload).decode('ascii')
    except SecretError:
        raise
    except Exception:
        raise SecretError('Could not securely store the credential in the OS keyring.') from None
    # Only ciphertext and a non-secret keyring record ID touch the project disk.
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False, encoding='utf-8') as f:
            temp_name = f.name
            os.chmod(temp_name, 0o600)
            json.dump(envelope, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and Path(temp_name).exists():
            Path(temp_name).unlink()
    return path


def load_secret(directory, provider, backend=None):
    path = credential_path(directory, provider)
    if not path.exists():
        return ''
    envelope = _read_envelope(path)
    backend = backend or secure_backend()
    try:
        master = backend.get_password(SERVICE, envelope['key_id'])
        if not master:
            raise SecretError('Wrapping key is missing from the OS keyring; the encrypted credential cannot be unlocked.')
        payload = json.loads(Fernet(master.encode('ascii')).decrypt(envelope['ciphertext'].encode('ascii')))
        if payload['provider'] != provider or not isinstance(payload['api_key'], str) or not payload['api_key']:
            raise ValueError()
        return payload['api_key']
    except SecretError:
        raise
    except InvalidToken:
        raise SecretError('Credential authentication failed: ciphertext was modified or the OS wrapping key is incorrect.') from None
    except Exception:
        raise SecretError('Could not unlock the encrypted credential using the OS keyring.') from None


def prompt_and_store(directory, provider):
    # Hidden terminal input: never a command argument, .env entry or application log.
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        try:
            value = getpass.getpass(f'{provider.capitalize()} API key (hidden): ')
        except getpass.GetPassWarning:
            raise SecretError('A terminal with hidden input is required.') from None
    return store_secret(directory, provider, value)
