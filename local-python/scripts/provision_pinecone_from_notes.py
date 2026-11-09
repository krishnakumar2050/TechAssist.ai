"""Read only the authorized Apple Note and encrypt its Pinecone credential.

Never writes note contents, plaintext credentials or wrapping keys to disk or stdout.
Run from the project root using its virtual environment.
"""
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
import sys

from techassist_rag.config import Settings
from techassist_rag.secrets import store_secret, load_secret, SecretError

SCRIPT = '''tell application "Notes"
    set selectedNotes to every note whose name is "Pinecone"
    if (count of selectedNotes) is not 1 then
        error "Expected exactly one note with the requested title"
    end if
    return body of item 1 of selectedNotes
end tell'''


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def main():
    result = subprocess.run(['/usr/bin/osascript', '-e', SCRIPT], capture_output=True, text=True, timeout=90)
    if result.returncode:
        print('Notes read failed. Check Notes automation access and that exactly one note is titled Pinecone.', file=sys.stderr)
        return 1
    parser = PlainText()
    parser.feed(result.stdout)
    text = '\n'.join(parser.parts)
    modern = set(re.findall(r'(?<![A-Za-z0-9_])pcsk_[A-Za-z0-9_-]{20,}', text))
    candidates = modern or set(re.findall(r'(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', text))
    if len(candidates) != 1:
        print('The note must contain exactly one identifiable Pinecone API key. No note contents or keys were displayed.', file=sys.stderr)
        return 1
    key = candidates.pop()
    settings = Settings.from_env()
    path = store_secret(settings.secrets_dir, 'pinecone', key)
    if load_secret(settings.secrets_dir, 'pinecone') != key:
        raise SecretError('Encrypted credential verification failed.')
    # Verify exact plaintext value does not occur in project text/config files.
    for directory in ('src', 'scripts', 'tests'):
        for file in Path(directory).rglob('*.py'):
            if key.encode() in file.read_bytes():
                raise SecretError('Plaintext credential detected in project source.')
    for file in (Path('.env'), Path('.env.example'), path):
        if file.is_file() and key.encode() in file.read_bytes():
            raise SecretError('Plaintext credential detected in project configuration.')
    print(f'Pinecone credential imported, encrypted and round-trip verified: {path}. Wrapping key: OS credential manager. No plaintext credential saved in project source/configuration.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Secure Notes import failed. No credential or note content was logged.', file=sys.stderr)
        sys.exit(1)
