# SPDX-License-Identifier: AGPL-3.0-only
"""Stock sdk/python HTTP client under the inherited pinned CLI execution guard."""
import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

ORIGIN = 'http://127.0.0.1:8824'
KEY = os.environ['OPENVIKING_CLI_TEST_API_KEY']
assert KEY and os.environ['OPENVIKING_URL'] == ORIGIN and os.environ['CLI_ADMITTED_PORT'] == '8824'
root = Path(os.environ['CLI_PIN_SOURCE']) / 'sdk/python'
sys.path[:0] = [str(root), os.environ['CLI_PY_DEPENDENCIES']]
from openviking_sdk import AsyncHTTPClient
from openviking_sdk.errors import NotFoundError, UnauthenticatedError


async def main():
    from importlib.metadata import version
    print(f'PYTHON {sys.version.split()[0]} / HTTPX {version("httpx")}')
    uri = f'viking://resources/client-py-{uuid4()}.txt'
    text = 'Fictional cobalt telescope at the observatory. Écho.\n'
    message = 'Synthetic session note for the Python SDK.'
    wire = []
    failures = 0

    async def guard_request(request):
        assert (request.url.scheme, request.url.host, request.url.port) == ('http', '127.0.0.1', 8824)

    async def observe(response):
        row = [response.request.method, response.request.url.path, response.status_code]
        if response.status_code >= 400:
            await response.aread()
            row.append(response.json()['error']['code'])
        wire.append(row)

    hooks = {'request': [guard_request], 'response': [observe]}
    api = AsyncHTTPClient(url=ORIGIN, api_key=KEY, timeout=5, event_hooks=hooks)
    anonymous = AsyncHTTPClient(url=ORIGIN, timeout=5, event_hooks=hooks)

    async def check(name, action):
        nonlocal failures
        wire.clear()
        try:
            evidence = await action()
            row = dict(name=name, vote='pass', wire=wire, evidence=evidence)
        except Exception as exc:
            failures += 1
            row = dict(name=name, vote='fail', wire=wire, error=type(exc).__name__, code=getattr(exc, 'code', None),
                       diagnostic=str(exc) if isinstance(exc, AssertionError) else None)
        print('SDK_NODE ' + json.dumps(row), flush=True)

    async def rejects(action, kind, http, code):
        try:
            await action()
        except kind as ex:
            assert ex.code == code and wire[-1][2:] == [http, code], wire
        else:
            raise AssertionError(f'expected {http} {code}')

    async def health():
        assert await anonymous.health() is True
        assert wire == [['GET', '/health', 200]], wire

    async def files():
        await rejects(lambda: api.stat(uri), NotFoundError, 404, 'NOT_FOUND')
        await api.write(uri, text, mode='create', wait=True)
        assert (await api.stat(uri))['isDir'] is False
        actual = await api.read(uri)
        assert actual == text
        assert wire[1:] == [['POST', '/api/v1/content/write', 200], ['GET', '/api/v1/fs/stat', 200],
                            ['GET', '/api/v1/content/read', 200]], wire
        data = actual.encode()
        return dict(uri=uri, bytes=len(data), sha256=sha256(data).hexdigest())

    async def search():
        found = await api.find('cobalt telescope observatory', target_uri='viking://resources', limit=5)
        hit = next((row for row in found['resources'] if row['uri'] == uri), None)
        assert hit is not None and 0 < hit['score'] < float('inf')
        assert wire == [['POST', '/api/v1/search/find', 200]], wire
        return dict(hit_uri=hit['uri'], score=hit['score'])

    async def auth():
        await rejects(lambda: anonymous.stat(uri), UnauthenticatedError, 401, 'UNAUTHENTICATED')
        assert wire == [['GET', '/api/v1/fs/stat', 401, 'UNAUTHENTICATED']], wire

    async def delete_file():
        await api.rm(uri, wait=True)
        await rejects(lambda: api.stat(uri), NotFoundError, 404, 'NOT_FOUND')
        assert wire == [['DELETE', '/api/v1/fs', 200], ['GET', '/api/v1/fs/stat', 404, 'NOT_FOUND']], wire

    async def session():
        sid = (await api.create_session())['session_id']
        assert isinstance(sid, str) and sid
        path = f'/api/v1/sessions/{sid}'
        try:
            assert (await api.get_session(sid))['session_id'] == sid
            await api.add_message(sid, 'user', content=message)
            messages = (await api.get_session_context(sid, 1000))['messages']
            assert len(messages) == 1 and messages[0]['role'] == 'user'
            assert messages[0]['parts'][0]['text'] == message
        finally:
            await api.delete_session(sid)
        await rejects(lambda: api.get_session(sid), NotFoundError, 404, 'NOT_FOUND')
        assert wire == [['POST', '/api/v1/sessions', 200], ['GET', path, 200], ['POST', f'{path}/messages', 200],
                        ['GET', f'{path}/context', 200], ['DELETE', path, 200], ['GET', path, 404, 'NOT_FOUND']], wire
        return dict(session_id=sid, message_text_sha256=sha256(message.encode()).hexdigest())

    try:
        await api.initialize()
        await anonymous.initialize()
        await check('health', health)
        try:
            await check('filesystem', files)
            await check('search', search)
            await check('auth-denial', auth)
        finally:
            await check('file-delete', delete_file)
        await check('session', session)
    finally:
        await api.close()
        await anonymous.close()
    return int(bool(failures))


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
