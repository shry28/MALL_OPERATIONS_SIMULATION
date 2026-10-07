import json
import os
import sqlite3
import threading


class Store:
    def __init__(self, path=None):
        default_path = os.path.join(os.path.dirname(__file__), 'mall.sqlite3')
        self.db = sqlite3.connect(path or os.getenv('DB_PATH', default_path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.pending_events = 0
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=NORMAL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS days(day_id TEXT PRIMARY KEY, status TEXT, total INTEGER,
            lost INTEGER, savings INTEGER, payload TEXT, summary TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
          CREATE TABLE IF NOT EXISTS ledger(day_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL,
            response TEXT NOT NULL, PRIMARY KEY(day_id, seq));
          CREATE INDEX IF NOT EXISTS idx_ledger_day_seq ON ledger(day_id, seq);
        ''')
        self.db.commit()

    def load(self, day_id, payload):
        with self.lock, self.db:
            self.db.execute('DELETE FROM ledger WHERE day_id=?', (day_id,))
            self.db.execute('INSERT OR REPLACE INTO days(day_id,status,total,lost,savings,payload,summary) VALUES(?,?,?,?,?,?,?)',
                            (day_id, 'ready', 0, 0, 0, json.dumps(payload), '{}'))
            self.pending_events = 0

    def save_event(self, day_id, event, response, summary, status, baseline):
        with self.lock:
            self.db.execute('INSERT INTO ledger(day_id,seq,event,response) VALUES(?,?,?,?)',
                            (day_id, event['seq'], json.dumps(event), json.dumps(response)))
            self.pending_events += 1
            if self.pending_events >= 100 or status == 'finished':
                totals = summary['totals']
                self.db.execute('UPDATE days SET status=?,total=?,lost=?,savings=?,summary=? WHERE day_id=?',
                                (status, totals['total_cost'], totals['lost_revenue'], baseline['total_cost']-totals['total_cost'],
                                 json.dumps(summary), day_id))
                self.db.commit()
                self.pending_events = 0

    def days(self):
        with self.lock:
            return [dict(day_id=r['day_id'], total_cost=r['total'] or 0, lost_revenue=r['lost'] or 0,
                         savings_vs_baseline=r['savings'] or 0) for r in self.db.execute("SELECT * FROM days ORDER BY rowid DESC")]

    def get_day(self, day_id):
        with self.lock:
            r = self.db.execute('SELECT * FROM days WHERE day_id=?', (day_id,)).fetchone()
            return dict(r) if r else None

    def ledger(self, day_id, offset=0, limit=100):
        with self.lock:
            rows = self.db.execute('SELECT event,response FROM ledger WHERE day_id=? ORDER BY seq LIMIT ? OFFSET ?',
                                   (day_id, limit, offset)).fetchall()
            return [dict(event=json.loads(r['event']), response=json.loads(r['response'])) for r in rows]
