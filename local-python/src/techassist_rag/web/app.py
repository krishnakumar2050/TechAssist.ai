"""FastAPI boundary: session ownership, CSRF, persistent turns and progress SSE."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import logging
from pathlib import Path
import secrets
from fastapi import FastAPI, Request, Response, Depends, HTTPException
from fastapi.responses import StreamingResponse, FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from .settings import AppSettings
from .database import Database, Conflict
from .schemas import TurnRequest
from .agent import Agent

log = logging.getLogger('techassist')
COOKIE = 'techassist_session'


def create_app(settings=None, database=None, agent=None):
    settings = settings or AppSettings.from_env()
    db = database or Database(settings.database_url)
    engine = agent or Agent(settings)
    jobs = set()
    @asynccontextmanager
    async def lifespan(app):
        yield
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)
        db.engine.dispose()
    app = FastAPI(title='TechAssist API', version='1.0.0', lifespan=lifespan)
    app.state.database, app.state.agent = db, engine
    app.add_middleware(SessionMiddleware, secret_key=settings.oidc_state_secret or secrets.token_urlsafe(32), session_cookie='techassist_oidc_state', https_only=settings.secure_cookies, same_site='lax', max_age=600)

    @app.middleware('http')
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    def identity(request: Request):
        user = db.identity(request.cookies.get(COOKIE))
        if not user:
            raise HTTPException(401, 'Sign in to continue.')
        return user

    def write_access(request: Request, user=Depends(identity)):
        origin = request.headers.get('origin')
        allowed = {settings.origin}
        if settings.auth_mode == 'local':
            allowed.update({'http://127.0.0.1:5173', 'http://localhost:5173'})
        if origin and origin not in allowed:
            raise HTTPException(403, 'Origin is not allowed.')
        if not secrets.compare_digest(request.headers.get('x-csrf-token', ''), user['csrf']):
            raise HTTPException(403, 'Refresh the page before continuing.')
        return user

    def owned(user, cid):
        c = db.get(user['owner'], cid)
        if not c:
            raise HTTPException(404, 'Conversation not found.')
        return c

    def set_cookie(response, token):
        response.set_cookie(COOKIE, token, httponly=True, secure=settings.secure_cookies, samesite='strict', max_age=604800, path='/')

    @app.get('/api/session')
    def session(request: Request, response: Response):
        user = db.identity(request.cookies.get(COOKIE))
        if not user:
            if settings.auth_mode != 'local':
                raise HTTPException(401, 'Sign in to continue.')
            # Local mode is deliberately restricted to loopback deployments.
            if request.client and request.client.host not in ('127.0.0.1', '::1', 'testclient'):
                raise HTTPException(403, 'Local sessions are available only on this machine.')
            token, csrf = db.new_session()
            set_cookie(response, token)
            user = db.identity(token)
        return {'csrf_token': user['csrf'], 'auth_mode': settings.auth_mode, 'display_name': 'Your workspace',
                'response_mode': settings.response_mode, 'model': {'ollama': settings.ollama_model, 'nebius': settings.nebius_model}.get(settings.response_mode)}

    @app.get('/api/health')
    def health():
        return {'status': 'ok', 'response_mode': settings.response_mode}

    @app.get('/api/conversations')
    def conversations(user=Depends(identity)):
        # Keep detailed facts/evidence off the sidebar listing.
        return [{k: c[k] for k in ('id', 'title', 'status', 'updated', 'version')} for c in db.list(user['owner'])]

    @app.post('/api/conversations', status_code=201)
    def create(user=Depends(write_access)):
        return db.create(user['owner'])

    @app.get('/api/conversations/{cid}')
    def conversation(cid: str, user=Depends(identity)):
        return owned(user, cid)

    @app.post('/api/conversations/{cid}/messages')
    async def message(cid: str, body: TurnRequest, user=Depends(write_access)):
        c = await asyncio.to_thread(owned, user, cid)
        if not body.message.strip():
            raise HTTPException(422, 'Enter a message.')
        if any(marker in body.message for marker in ('pcsk_', 'sk-proj-')):
            raise HTTPException(422, 'Please remove API keys from your message. Never share credentials in chat.')
        cached = await asyncio.to_thread(db.previous, cid, body.request_id)
        if cached:
            async def replay():
                yield 'event: completed\ndata: ' + json.dumps(cached) + '\n\n'
            return StreamingResponse(replay(), media_type='text/event-stream')
        if body.action in ('worked', 'failed', 'cannot') and body.step_id != (c['state'].get('pending') or {}).get('id'):
            raise HTTPException(409, 'This step is no longer active. Reload the conversation.')
        try:
            lease = await asyncio.to_thread(db.claim, user['owner'], cid)
        except Conflict as exc:
            raise HTTPException(409, str(exc))
        # Reload after acquiring the database lease so a concurrent completed turn cannot leave stale memory.
        c = await asyncio.to_thread(owned, user, cid)
        cached = await asyncio.to_thread(db.previous, cid, body.request_id)
        if cached:
            await asyncio.to_thread(db.release, cid, lease)
            async def replay_after_claim():
                yield 'event: completed\ndata: ' + json.dumps(cached) + '\n\n'
            return StreamingResponse(replay_after_claim(), media_type='text/event-stream')
        queue = asyncio.Queue()
        loop = asyncio.get_running_loop()
        def progress(phase):
            loop.call_soon_threadsafe(queue.put_nowait, ('progress', {'phase': phase}))
        def work():
            try:
                if settings.response_mode in ('ollama', 'nebius'):
                    progress('planning')
                state, answer = engine.turn(c, body, progress)
                db.finish(cid, lease, body, state, answer)
                loop.call_soon_threadsafe(queue.put_nowait, ('completed', answer))
            except Exception as exc:
                # Never log provider exception strings, request payloads or decrypted credentials.
                log.warning('Turn failed: %s; request=%s', type(exc).__name__, body.request_id)
                loop.call_soon_threadsafe(queue.put_nowait, ('error', {'message': 'The support service could not complete this turn. Your previous progress is saved. Retry shortly.', 'request_id': body.request_id}))
            finally:
                db.release(cid, lease)
        task = asyncio.create_task(asyncio.to_thread(work))
        jobs.add(task)
        def task_finished(done):
            jobs.discard(done)
            if not done.cancelled() and done.exception():
                log.warning('Background task failed: %s', type(done.exception()).__name__)
        task.add_done_callback(task_finished)
        async def events():
            yield 'event: progress\ndata: {"phase":"understanding"}\n\n'
            while True:
                try:
                    kind, value = await asyncio.wait_for(queue.get(), timeout=10)
                except asyncio.TimeoutError:
                    yield ': keepalive\n\n'
                    continue
                yield f'event: {kind}\ndata: {json.dumps(value)}\n\n'
                if kind in ('completed', 'error'):
                    break
        return StreamingResponse(events(), media_type='text/event-stream', headers={'X-Accel-Buffering': 'no'})

    @app.post('/api/logout')
    def logout(request: Request, response: Response, user=Depends(write_access)):
        db.end_session(request.cookies.get(COOKIE, ''))
        response.delete_cookie(COOKIE)
        return {'ok': True}

    if settings.auth_mode == 'oidc':
        from authlib.integrations.starlette_client import OAuth
        oauth = OAuth()
        oauth.register(name='company', client_id=settings.oidc_client_id, client_secret=settings.oidc_client_secret,
                       server_metadata_url=settings.oidc_metadata_url, client_kwargs={'scope': 'openid profile email'})
        @app.get('/api/auth/login')
        async def login(request: Request):
            return await oauth.company.authorize_redirect(request, settings.origin + '/api/auth/callback')
        @app.get('/api/auth/callback')
        async def callback(request: Request):
            try:
                token = await oauth.company.authorize_access_token(request)
                claims = token.get('userinfo')
                if not claims or not claims.get('sub') or not claims.get('iss'):
                    raise ValueError('Missing verified identity')
                owner = hashlib.sha256(f"{claims['iss']}|{claims['sub']}".encode()).hexdigest()
                cookie, csrf = db.new_session(owner)
                response = RedirectResponse('/')
                set_cookie(response, cookie)
                return response
            except Exception:
                raise HTTPException(401, 'Employee sign-in failed.') from None
    else:
        @app.get('/api/auth/login')
        def local_login():
            return RedirectResponse('/')

    @app.get('/api/{rest:path}')
    def missing_api(rest: str):
        raise HTTPException(404, 'API endpoint not found.')

    dist = Path.cwd() / 'frontend' / 'dist'
    if (dist / 'assets').exists():
        app.mount('/assets', StaticFiles(directory=dist / 'assets'), name='assets')
    @app.get('/')
    def frontend():
        if not (dist / 'index.html').exists():
            raise HTTPException(503, 'Build the React frontend first; see APPLICATION.md.')
        return FileResponse(dist / 'index.html')
    return app
