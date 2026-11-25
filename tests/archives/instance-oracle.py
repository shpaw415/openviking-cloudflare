# SPDX-License-Identifier: AGPL-3.0-only
"""Independent archive/SQLite checks, solely for the stopped synthetic Workerd fixture."""
from contextlib import closing
from hashlib import sha256
import hmac
from io import BytesIO
import json
from pathlib import Path
import base64
import sqlite3
import sys
import time
from zipfile import ZIP_STORED, ZipFile


def sha(data):
    return sha256(data).hexdigest()


def data_json(data):
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()


def zip_mode(mode):
    secret = sys.stdin.buffer.read(32)
    with ZipFile(BytesIO(sys.stdin.buffer.read(13 * 1024 * 1024))) as archive:
        assert len(archive.namelist()) == len(set(archive.namelist()))
        assert archive.testzip() is None
        members = {name: archive.read(name) for name in archive.namelist()}
    data = members['inventory.json']
    m = json.loads(data)
    a, b = m['source'], m['destination']

    def seal(content):
        body = data_json(['openviking:backup:v1', 'instance:v1:inventory', 'instance', a['id'],
                          a['id'], a['control'], b['id'], b['control'], sha(content)])
        return hmac.digest(secret, body, 'sha256').hex().encode()

    assert hmac.compare_digest(seal(data), members['inventory.hmac'])
    if mode == 'archive':
        assert m['kind'] == 'openviking.instance-backup' and m['format_version'] == 1 and m['profile'] == 'edge-v1'
        assert a['id'] != b['id'] and a['control'] != b['control']
        assert len(m['accounts']) == 2
        assert set(members) == {'inventory.json', 'inventory.hmac', 'configuration.json', *(x['path'] for x in m['accounts'])}
        def verify(d, content):
            assert d['size'] == len(content) and d['sha256'] == sha(content)
        verify(m['configuration'], members['configuration.json'])
        result = {}
        for account in m['accounts']:
            assert account['seal'].startswith('acl2-')
            packed = members[account['path']]
            verify(account, packed)
            with ZipFile(BytesIO(packed)) as edge:
                assert edge.testzip() is None
                assert set(edge.namelist()) == {'manifest.json', 'domains.json', 'content.ovpack'}
                sub = json.loads(edge.read('manifest.json'))
                assert sub['kind'] == 'openviking.edge-backup' and sub['format_version'] == 1
                for desc in sub['entries']:
                    verify(desc, edge.read(desc['path']))
                domains = json.loads(edge.read('domains.json'))
                with ZipFile(BytesIO(edge.read('content.ovpack'))) as ovpack:
                    assert ovpack.testzip() is None
                    root = 'openviking-backup/'
                    manifest = json.loads(ovpack.read(root + '_ovpack/manifest.json'))
                    assert manifest['kind'] == 'openviking.ovpack' and manifest['format_version'] == 3
                    assert manifest['root']['uri'] == 'viking://' and manifest['root']['package_type'] == 'backup'
                    assert manifest['scopes'] == ['resources', 'user']
                    paths = {name[len(root + 'files/'):]: sha(ovpack.read(name)) for name in ovpack.namelist()
                             if name.startswith(root + 'files/') and not name.endswith('/')}
            result[account['account_id']] = {'files': paths, 'sessions': len(domains['sessions']), 'skills': len(domains['skills'])}
        print(json.dumps({'source': a, 'destination': b, 'job': sha(data), 'members': result,
                          'settings': json.loads(members['configuration.json'])}))
        return
    if mode == 'missing':
        # Correctly signed but logically incomplete: keep the second physical member outside the inventory.
        m['accounts'].pop()
    elif mode == 'swap':
        first, second = (x['path'] for x in m['accounts'])
        members[first], members[second] = members[second], members[first]
    elif mode == 'wrong-peer':
        m['destination'] = {**b, 'id': '0' * 32}
    elif mode == 'config':
        raw = json.loads(members['configuration.json'])
        raw['cluster']['unapproved_field'] = True
        config = members['configuration.json'] = data_json(raw)
        m['configuration'].update(size=len(config), sha256=sha(config))
    else:
        raise ValueError('Not an archive fixture mode')
    data = members['inventory.json'] = data_json(m)
    members['inventory.hmac'] = seal(data)
    out = BytesIO()
    with ZipFile(out, 'w', ZIP_STORED) as z:
        for name, value in members.items():
            z.writestr(name, value)
    sys.stdout.buffer.write(out.getvalue())


if len(sys.argv) == 2:
    zip_mode(sys.argv[1])
    raise SystemExit

action, directory, *args = sys.argv[1:]
root = Path(directory).resolve(strict=True)
assert root.parent == Path(__file__).resolve().parents[2] / '.work' and root.name.startswith('ib-') and (root / 'adapter.mjs').is_file()
result = {'progress': None, 'commits': [], 'workspaces': 0}
mutated = 0
for file in sorted((root / 'state').rglob('*.sqlite')):
    assert file.resolve() == file and file.stat().st_nlink == 1
    mode = 'ro' if action == 'inspect' else 'rw'
    with closing(sqlite3.connect(f'{file.as_uri()}?mode={mode}', uri=True)) as sql:
        tables = {name for (name,) in sql.execute('SELECT name FROM sqlite_schema WHERE type="table"')}
        control = 'ov_control_instance_restore' in tables
        workspace = 'ov_edge_fs_entry' in tables
        result['workspaces'] += workspace
        if control:
            result['progress'] = list(sql.execute('SELECT receipts,released FROM ov_control_instance_restore WHERE id=1').fetchone())
            result['progress'][0] = json.loads(result['progress'][0])
            if action == 'pause-ack':
                sql.execute("CREATE TRIGGER fixture_ack_stop BEFORE UPDATE OF receipts ON ov_control_instance_restore BEGIN SELECT RAISE(ABORT, 'fixture paused after workspace commit'); END")
                mutated += 1
            if action == 'resume-ack':
                sql.execute('DROP TRIGGER fixture_ack_stop')
                mutated += 1
        if 'ov_edge_instance_restore_receipt' in tables:
            account, receipt = sql.execute('SELECT account, receipt FROM ov_edge_instance_restore_receipt WHERE id=1').fetchone()
            files = sql.execute('SELECT count(*) FROM ov_edge_fs_entry WHERE is_dir=0').fetchone()[0]
            sessions = sql.execute('SELECT count(*) FROM ov_sessions').fetchone()[0] if 'ov_sessions' in tables else 0
            result['commits'].append([account, receipt, files, sessions])
        if action == 'seed-attachment' and workspace and sql.execute(
            'SELECT 1 FROM ov_edge_fs_entry WHERE account_id=? LIMIT 1', args).fetchone():
            id_ = 'att_' + '7' * 32
            if 'ov_edge_gateway_attachment' in tables:
                # Preserve the v1 presence witness on the assembled Transferts schema.
                data = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XyZkAAAAASUVORK5CYII=')
                sql.execute('''INSERT INTO ov_edge_gateway_attachment
                    (account_id,user_id,agent_id,id,revision,filename,content_type,size,expires_at,body) VALUES (?,?,?,?,?,?,?,?,?,?)''',
                            (args[0], 'admin', 'default', id_, '70000000-0000-4000-8000-000000000000', 'fixture.png',
                             'image/png', len(data), int(time.time() * 1000) + 60000, data))
            else:
                sql.execute('CREATE TABLE ov_edge_gateway_attachment (attachment_id TEXT PRIMARY KEY)')
                sql.execute('INSERT INTO ov_edge_gateway_attachment VALUES (?)', (id_,))
            mutated += 1
        sql.commit()
assert action == 'inspect' or mutated == 1
print(json.dumps(result))
