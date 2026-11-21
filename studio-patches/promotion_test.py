"""Exercise the promotion primitive on local dummy directories, never dist/studio."""
import hashlib
from pathlib import Path
import runpy
import tempfile
import unittest

PATCHES = Path(__file__).resolve().parent
WORK = PATCHES.parent / '.work' / 'studio'
SCRIPT = PATCHES / 'promote-studio.py'


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), 'The single-writer promotion gate is not implemented')
        self.ops = runpy.run_path(str(SCRIPT))
        scratch = tempfile.TemporaryDirectory(prefix='promotion-fixture-', dir=WORK)
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.active = self.root / 'active'
        self.stage = self.root / 'stage'
        self.active.mkdir()
        self.stage.mkdir()
        self.old = {'index.html': digest(b'current')}
        self.new = {'index.html': digest(b'candidate')}
        (self.active / 'index.html').write_bytes(b'current')
        (self.stage / 'index.html').write_bytes(b'candidate')

    def test_lock_refuses_a_second_writer(self):
        lock = self.root / 'writer.lock'
        with self.ops['writer_lock'](lock):
            with self.assertRaisesRegex(RuntimeError, 'another Studio writer'):
                with self.ops['writer_lock'](lock):
                    self.fail('second writer admitted')
        with self.ops['writer_lock'](lock):
            pass

    def test_exchange_is_real_and_keeps_old_bytes_and_source(self):
        transaction = self.root / 'txn'
        transaction.mkdir()
        self.ops['checked_exchange'](self.active, self.stage, transaction, self.old, self.new)
        self.assertEqual((self.active / 'index.html').read_bytes(), b'candidate')
        self.assertEqual((transaction / 'previous' / 'index.html').read_bytes(), b'current')
        self.assertEqual((self.stage / 'index.html').read_bytes(), b'candidate')

    def test_wrong_previous_sha_refuses_before_copy_or_exchange(self):
        transaction = self.root / 'txn'
        transaction.mkdir()
        (self.active / 'index.html').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'manifest mismatch'):
            self.ops['checked_exchange'](self.active, self.stage, transaction, self.old, self.new)
        self.assertEqual((self.active / 'index.html').read_bytes(), b'changed')
        self.assertEqual(list(transaction.iterdir()), [])

    def test_refuses_extra_asset_and_symlink(self):
        extra = self.stage / 'extra.js'
        extra.write_bytes(b'extra')
        with self.assertRaisesRegex(RuntimeError, 'manifest mismatch'):
            self.ops['verify_tree'](self.stage, self.new)
        extra.unlink()
        extra.symlink_to(self.active / 'index.html')
        with self.assertRaisesRegex(RuntimeError, 'not a regular asset'):
            self.ops['verify_tree'](self.stage, self.new)

    def test_red_campaign_keeps_gate_closed_even_if_inventory_is_complete(self):
        full = dict(passed=1700, failed=1, skipped=0, todo=0, reported=221, success=False)
        with self.assertRaisesRegex(RuntimeError, 'red or incomplete'):
            self.ops['require_green'](full, 221, 1701)
        self.ops['require_green'](dict(full, success=True, passed=1701, failed=0), 221, 1701)

    def test_shards_or_multiple_workers_cannot_qualify_for_promotion(self):
        for evidence in ({}, {'strategy': 'sharded', 'workers': 1}, {'strategy': 'sequential', 'workers': 4}):
            with self.assertRaisesRegex(RuntimeError, 'one worker is required'):
                self.ops['require_sequential']({'runner': evidence})
        self.ops['require_sequential']({'runner': {'strategy': 'sequential', 'workers': 1}})


if __name__ == '__main__':
    unittest.main(verbosity=2)
