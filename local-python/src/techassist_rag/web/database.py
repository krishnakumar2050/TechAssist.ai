"""Persistent owner-scoped conversations with per-conversation processing leases."""
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import secrets
import time
import uuid
from sqlalchemy import create_engine, String, Text, JSON, Float, Integer, select, update, delete, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def now():
    return datetime.now(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class BrowserSession(Base):
    __tablename__ = 'browser_sessions'
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner: Mapped[str] = mapped_column(String(128))
    expires: Mapped[float] = mapped_column(Float)
    csrf: Mapped[str] = mapped_column(String(100))


class Conversation(Base):
    __tablename__ = 'conversations'
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    owner: Mapped[str] = mapped_column(String(128), index=True)
    title: Mapped[str] = mapped_column(String(160), default='New conversation')
    status: Mapped[str] = mapped_column(String(40), default='collecting_context')
    state: Mapped[dict] = mapped_column(JSON, default=dict)
    updated: Mapped[str] = mapped_column(String(40), default=now)
    lease: Mapped[str] = mapped_column(String(40), default='')
    busy_until: Mapped[float] = mapped_column(Float, default=0)
    version: Mapped[int] = mapped_column(Integer, default=0)


class Message(Base):
    __tablename__ = 'messages'
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: str(uuid.uuid4()))
    conversation_id: Mapped[str] = mapped_column(String(40), index=True)
    request_id: Mapped[str] = mapped_column(String(100), index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created: Mapped[str] = mapped_column(String(40), default=now)


class Conflict(Exception):
    pass


class Database:
    def __init__(self, url):
        if url.startswith('sqlite:///'):
            file = url.removeprefix('sqlite:///')
            if file != ':memory:':
                Path(file).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        opts = {'connect_args': {'check_same_thread': False}} if url.startswith('sqlite') else {'pool_pre_ping': True}
        if url.endswith(':memory:'):
            from sqlalchemy.pool import StaticPool
            opts['poolclass'] = StaticPool
        self.engine = create_engine(url, **opts)
        if url.startswith('sqlite'):
            @event.listens_for(self.engine, 'connect')
            def pragmas(connection, record):
                connection.execute('PRAGMA busy_timeout=5000')
                connection.execute('PRAGMA journal_mode=WAL')
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(self.engine, expire_on_commit=False)

    def new_session(self, owner=None):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        with self.sessions.begin() as db:
            db.add(BrowserSession(token_hash=hashlib.sha256(token.encode()).hexdigest(), owner=owner or str(uuid.uuid4()), expires=time.time()+604800, csrf=csrf))
        return token, csrf

    def identity(self, token):
        with self.sessions() as db:
            row = db.get(BrowserSession, hashlib.sha256(token.encode()).hexdigest()) if token else None
            if row and row.expires > time.time():
                return {'owner': row.owner, 'csrf': row.csrf}
        return None

    def end_session(self, token):
        with self.sessions.begin() as db:
            db.execute(delete(BrowserSession).where(BrowserSession.token_hash == hashlib.sha256(token.encode()).hexdigest()))

    def create(self, owner):
        with self.sessions.begin() as db:
            row = Conversation(id=str(uuid.uuid4()), owner=owner, state={})
            db.add(row)
        return self.serialize(row)

    @staticmethod
    def serialize(row):
        return {k: getattr(row, k) for k in ('id', 'title', 'status', 'state', 'updated', 'version')}

    def list(self, owner):
        with self.sessions() as db:
            return [self.serialize(c) for c in db.scalars(select(Conversation).where(Conversation.owner == owner).order_by(Conversation.updated.desc()))]

    def get(self, owner, cid):
        with self.sessions() as db:
            row = db.scalar(select(Conversation).where(Conversation.id == cid, Conversation.owner == owner))
            if not row:
                return None
            result = self.serialize(row)
            result['messages'] = [{'id': m.id, 'role': m.role, 'content': m.content, 'payload': m.payload, 'created': m.created} for m in db.scalars(select(Message).where(Message.conversation_id == cid).order_by(Message.created, Message.id))]
            return result

    def previous(self, cid, request_id):
        with self.sessions() as db:
            row = db.scalar(select(Message).where(Message.conversation_id == cid, Message.request_id == request_id, Message.role == 'assistant'))
            return row.payload if row else None

    def claim(self, owner, cid):
        token = str(uuid.uuid4())
        with self.sessions.begin() as db:
            result = db.execute(update(Conversation).where(Conversation.id == cid, Conversation.owner == owner, Conversation.busy_until < time.time()).values(lease=token, busy_until=time.time()+600))
            if result.rowcount != 1:
                raise Conflict('A reply is already being prepared for this conversation.')
        return token

    def release(self, cid, lease):
        with self.sessions.begin() as db:
            db.execute(update(Conversation).where(Conversation.id == cid, Conversation.lease == lease).values(busy_until=0, lease=''))

    def finish(self, cid, lease, req, state, reply):
        with self.sessions.begin() as db:
            row = db.scalar(select(Conversation).where(Conversation.id == cid, Conversation.lease == lease))
            if not row:
                raise Conflict('This request expired; reload the conversation.')
            row.state, row.status, row.updated = state, reply['status'], now()
            row.version += 1
            if row.title == 'New conversation':
                row.title = req.message[:80]
            row.lease, row.busy_until = '', 0
            db.add(Message(conversation_id=cid, request_id=req.request_id, role='user', content=req.message))
            db.add(Message(conversation_id=cid, request_id=req.request_id, role='assistant', content=reply['summary'], payload=reply))
