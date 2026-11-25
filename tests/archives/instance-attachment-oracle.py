# SPDX-License-Identifier: AGPL-3.0-only
"""Independent fixtures and read-only SQLite observations of the owned instance test."""
from contextlib import closing
from hashlib import sha256
import hmac
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import sys
from zipfile import ZIP_STORED, ZipFile


def digest(data):
    return sha256(data).hexdigest()


def compact(data):
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()


def members(data):
    with ZipFile(BytesIO(data)) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == len(set(archive.namelist()))
        return {n: archive.read(n) for n in archive.namelist()}


def pack(entries):
    out = BytesIO()
    with ZipFile(out, 'w', ZIP_STORED) as archive:
        for key, value in entries.items():
            archive.writestr(key, value)
    return out.getvalue()


def archive_fixture(action):
    test_authority = json.loads(sys.stdin.buffer.readline(4096))
    key = bytes.fromhex(test_authority['key'])
    container = members(sys.stdin.buffer.read(30 * 1024 * 1024))
    manifest = json.loads(container['inventory.json'])
    assert (manifest['format_version'], manifest['profile']) == (2, 'edge-v1-attachments')
    source, dest = manifest['source'], manifest['destination']
    pair = [source['id'], source['control'], dest['id'], dest['control']]

    def seal(label, actor, realm, *values):
        return hmac.digest(key, compact(['openviking:backup:v1', label, actor, realm, *values]), 'sha256').hex()

    def inventory_seal():
        return seal('instance:v1:inventory', 'instance', source['id'], *pair, digest(container['inventory.json']))

    assert hmac.compare_digest(container['inventory.hmac'].decode(), inventory_seal())
    seen = {}
    for desc in manifest['accounts']:
        account, path = desc['account_id'], desc['path']
        blob = container[path]
        assert len(blob) == desc['size'] and digest(blob) == desc['sha256']
        acl, mac = desc['seal'].split('.')
        assert acl.startswith('acl2-')
        label = 'instance-member:v2:' + ':'.join(pair + [manifest['capture']])
        realm = test_authority['scopes'][account]
        assert hmac.compare_digest(mac, seal(label, account, realm, digest(blob), acl))
        archive = members(blob)
        index = json.loads(archive['attachments.json'])
        seen[account] = index
        assert set(archive) == {'attachments.json', 'workspace.edge.zip'} | {f"attachments/{r['id']}.bin" for r in index}
        inner = members(archive['workspace.edge.zip'])
        assert set(inner) == {'manifest.json', 'content.ovpack', 'domains.json'}
        for row in index:
            assert set(row) == {'id', 'user_id', 'agent_id', 'filename', 'content_type', 'size', 'expires_at', 'sha256'}
            data = archive[f"attachments/{row['id']}.bin"]
            assert len(data) == row['size'] and digest(data) == row['sha256']
        # Only pre-authorized malformed inputs from the wholly synthetic oracle.
        if action != 'wire' and index and account == test_authority['account']:
            if action == 'wrong-seat':
                index[0]['agent_id'] = 'not-provisioned'
            elif action == 'wrong-hash':
                index[0]['sha256'] = '0' * 64
            elif action == 'missing-piece':
                del archive[f"attachments/{index[0]['id']}.bin"]
            else:
                raise ValueError('unknown archive fixture')
            archive['attachments.json'] = compact(index)
            blob = container[path] = pack(archive)
            desc.update(size=len(blob), sha256=digest(blob), seal=acl + '.' + seal(label, account, realm, digest(blob), acl))
    if action == 'wire':
        print(json.dumps(seen))
        return
    container['inventory.json'] = compact(manifest)
    container['inventory.hmac'] = inventory_seal().encode()
    sys.stdout.buffer.write(pack(container))


def state(directory):
    root = Path(directory).resolve(strict=True)
    assert root.parent == Path(__file__).resolve().parents[2] / '.work' and root.name.startswith('ib-')
    output = {'rows': {}, 'receipts': [], 'tickets': 0, 'staging': 0, 'job_tables': 0}
    for db in sorted((root / 'state').rglob('*.sqlite')):
        assert db.resolve() == db and db.stat().st_nlink == 1
        with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)) as conn:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
            if 'ov_edge_gateway_attachment' in tables:
                values = conn.execute('SELECT id,account_id,user_id,agent_id,filename,content_type,expires_at,revision,body FROM ov_edge_gateway_attachment LIMIT 16').fetchall()
                for id_, account, user, agent, name, mime, expiry, revision, body in values:
                    assert id_ not in output['rows']
                    output['rows'][id_] = [account, user, agent, name, mime, expiry, revision, digest(body)]
            if 'ov_edge_instance_restore_receipt' in tables:
                output['receipts'].extend(conn.execute('SELECT account,receipt FROM ov_edge_instance_restore_receipt WHERE id=1').fetchall())
            if 'ov_edge_gateway_transfer' in tables:
                output['tickets'] += conn.execute('SELECT count(*) FROM ov_edge_gateway_transfer').fetchone()[0]
            if 'ov_edge_fs_upload' in tables:
                output['staging'] += conn.execute('SELECT count(*) FROM ov_edge_fs_upload').fetchone()[0]
            output['job_tables'] += int('ov_jobs' in tables)
    print(json.dumps(output))


if len(sys.argv) == 2:
    archive_fixture(sys.argv[1])
elif len(sys.argv) == 3 and sys.argv[1] == 'state':
    state(sys.argv[2])
else:
    raise SystemExit(2)
