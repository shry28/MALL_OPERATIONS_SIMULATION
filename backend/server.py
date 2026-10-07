import json
import os
import re
import socket
import threading
import csv
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from policy import build_policy
from simulation import Simulation
from storage import Store

store = Store()
lock = threading.RLock()
current = None


def baseline(items, events, shelf_first):
    sim = Simulation(items)
    for event in events:
        routes = {line['item_id']: min(line['qty'], sim.states[line['item_id']].shelf)
                  for line in event['lines']} if event['type'] == 'online' and shelf_first else {}
        sim.apply(event, routes)
    return sim


def process_event(c, body):
    """Apply one validated-in-order event to the active run and its baselines."""
    if body.get('seq') != c['last'] + 1 or body.get('seq') > c['events_total']:
        raise ValueError(f"out_of_order:{c['last'] + 1}")
    desired = c['policy'].choose(body, c['sim'])
    if body['type'] == 'online':
        response = {'seq': body['seq'], 'type': 'online', 'lines': c['sim'].apply(body, desired)}
    else:
        c['sim'].apply(body)
        response = {'seq': body['seq'], 'type': 'walk_in', 'status': 'ok'}
    for index, baseline_sim in enumerate(c['baseline_sims']):
        baseline_routes = ({line['item_id']: min(line['qty'], baseline_sim.states[line['item_id']].shelf)
                            for line in body['lines']} if body['type'] == 'online' and index == 0 else {})
        baseline_sim.apply(body, baseline_routes)
    c['last'] = body['seq']
    status = 'finished' if c['last'] == c['events_total'] else 'running'
    snapshot_due = c['last'] % 100 == 0 or status == 'finished'
    if snapshot_due:
        c['cost_points'].append({'seq': c['last'], 'total_cost': c['sim'].summary_totals()['total_cost'],
                                 'baseline_cost': min(sim.summary_totals()['total_cost'] for sim in c['baseline_sims'])})
    store.save_event(c['day_id'], body, response, make_summary(c) if snapshot_due else None, status, c['baseline'])
    return response


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    wbufsize = 65536

    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    def send_json(self, code, data):
        body = json.dumps(data, separators=(',', ':')).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()
        self.close_connection = True

    def read_json(self):
        n = int(self.headers.get('Content-Length', '0'))
        if n > 25 * 1024 * 1024:
            raise ValueError('request too large')
        return json.loads(self.rfile.read(n))

    def do_OPTIONS(self):
        self.send_response(204); self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type'); self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); self.send_header('Content-Length','0'); self.end_headers()

    def do_GET(self):
        path = urlparse(self.path)
        if path.path == '/api/v1/health': return self.send_json(200, {'status':'ok'})
        if path.path == '/api/v1/days': return self.send_json(200, store.days())
        match = re.fullmatch(r'/api/v1/day/([^/]+)/(summary|events)', path.path)
        if match:
            day_id, action = match.groups(); row = store.get_day(day_id)
            if not row: return self.send_json(404, {'error':'not_found','message':'day not found'})
            if action == 'summary':
                if day_id == (current or {}).get('day_id'):
                    with lock: summary = make_summary(current)
                else: summary = json.loads(row['summary'] or '{}')
                return self.send_json(200, summary)
            q=parse_qs(path.query); offset=max(0,int(q.get('offset',['0'])[0])); limit=min(500,max(1,int(q.get('limit',['100'])[0])))
            return self.send_json(200, {'events':store.ledger(day_id,offset,limit),'offset':offset,'limit':limit})
        return self.send_json(404, {'error':'not_found','message':'route not found'})

    def do_POST(self):
        global current
        try: body=self.read_json()
        except Exception as exc: return self.send_json(400, {'error':'invalid_request','message':str(exc)})
        if self.path == '/api/v1/day/load':
            try:
                items=body['items']; events=body['events']; day_id=body['day_id']
                # Plan and baseline calculations use the same transition simulator as live replay.
                policy=build_policy(items, events)
                base_shelf=baseline(items,events,True); base_inventory=baseline(items,events,False)
                base_shelf_cost=base_shelf.summary_totals()['total_cost']; base_inventory_cost=base_inventory.summary_totals()['total_cost']
                base={'shelf_first_cost':base_shelf_cost,'inventory_only_cost':base_inventory_cost,'total_cost':min(base_shelf_cost,base_inventory_cost)}
                sim=Simulation(items)
                payload={'day_id':day_id,'items':items,'events':events}
                store.load(day_id,payload)
                with lock: current={'day_id':day_id,'items':items,'events_total':len(events),'last':0,'sim':sim,'policy':policy,'baseline':base,'baseline_sims':(Simulation(items),Simulation(items)),'cost_points':[{'seq':0,'total_cost':0,'baseline_cost':0}],'started':True}
                return self.send_json(200, {'day_id':day_id,'status':'ready','event_count':len(events)})
            except Exception as exc: return self.send_json(400, {'error':'load_failed','message':str(exc)})
        if self.path in ('/api/v1/day/events', '/api/v1/day/events/batch'):
            batch = self.path.endswith('/batch')
            events = body.get('events') if batch and isinstance(body, dict) else [body]
            if not isinstance(events, list) or (batch and not events):
                return self.send_json(400, {'error': 'invalid_request', 'message': 'events must be a non-empty array'})
            with lock:
                c=current
                if not c: return self.send_json(409, {'error':'no_day_loaded','message':'load a day first'})
                responses=[]
                for event in events:
                    try: responses.append(process_event(c,event))
                    except ValueError as exc:
                        expected=int(str(exc).split(':')[-1]) if str(exc).startswith('out_of_order:') else c['last']+1
                        return self.send_json(409, {'error':'out_of_order','expected':expected})
                return self.send_json(200, {'responses':responses,'events_processed':c['last']} if batch else responses[0])
        return self.send_json(404, {'error':'not_found','message':'route not found'})

    def log_message(self, *_): pass


def load_default_sample():
    """Populate a fresh local install with the supplied first sample day."""
    global current
    if any(day['day_id'] == 'sample_day_1' for day in store.days()):
        return
    project_dir = Path(__file__).resolve().parent.parent
    items_path = Path(os.getenv('ITEMS_PATH', project_dir / 'data' / 'items.csv'))
    day_path = Path(os.getenv('DAY_PATH', project_dir / 'days' / 'sample_day_1.json'))
    if not items_path.is_file() or not day_path.is_file():
        return
    numeric = ('unit_price_paise', 'initial_shelf_qty', 'refill_cost_per_unit_paise',
               'online_pull_cost_per_unit_paise')
    with items_path.open(newline='', encoding='utf-8-sig') as source:
        items = list(csv.DictReader(source))
    for item in items:
        for key in numeric:
            item[key] = int(item[key])
    day = json.loads(day_path.read_text(encoding='utf-8'))
    events = day['events']
    policy = build_policy(items, events)
    base_shelf = baseline(items, events, True)
    base_inventory = baseline(items, events, False)
    base_shelf_cost = base_shelf.summary_totals()['total_cost']
    base_inventory_cost = base_inventory.summary_totals()['total_cost']
    base = {'shelf_first_cost': base_shelf_cost, 'inventory_only_cost': base_inventory_cost,
            'total_cost': min(base_shelf_cost, base_inventory_cost)}
    sim = Simulation(items)
    baseline_sims = (Simulation(items), Simulation(items))
    current = {'day_id': day['day_id'], 'items': items, 'events_total': len(events), 'last': 0,
               'sim': sim, 'policy': policy, 'baseline': base, 'baseline_sims': baseline_sims,
               'cost_points': [{'seq': 0, 'total_cost': 0, 'baseline_cost': 0}], 'started': True}
    store.load(day['day_id'], {'day_id': day['day_id'], 'items': items, 'events': events})
    for event in events:
        desired = policy.choose(event, sim)
        routes = sim.apply(event, desired) if event['type'] == 'online' else sim.apply(event)
        response = ({'seq': event['seq'], 'type': 'online', 'lines': routes}
                    if event['type'] == 'online'
                    else {'seq': event['seq'], 'type': 'walk_in', 'status': 'ok'})
        for index, baseline_sim in enumerate(baseline_sims):
            baseline_routes = ({line['item_id']: min(line['qty'], baseline_sim.states[line['item_id']].shelf)
                                for line in event['lines']} if event['type'] == 'online' and index == 0 else {})
            baseline_sim.apply(event, baseline_routes)
        current['last'] = event['seq']
        status = 'finished' if event['seq'] == len(events) else 'running'
        if event['seq'] % 100 == 0 or status == 'finished':
            current['cost_points'].append({'seq': event['seq'],
                'total_cost': sim.summary_totals()['total_cost'],
                'baseline_cost': min(x.summary_totals()['total_cost'] for x in baseline_sims)})
        snapshot_due = event['seq'] % 100 == 0 or status == 'finished'
        store.save_event(day['day_id'], event, response, make_summary(current) if snapshot_due else None, status, base)


def make_summary(c):
    totals=c['sim'].summary_totals()
    current_baseline=min(sim.summary_totals()['total_cost'] for sim in c['baseline_sims'])
    return {'day_id':c['day_id'],'status':'finished' if c['last']==c['events_total'] else ('running' if c['last'] else 'ready'),
            'events_processed':c['last'],'events_total':c['events_total'],'totals':totals,'baseline':c['baseline'],
            'baseline_progress_total_cost':current_baseline,'cost_points':c['cost_points'],
            'savings_vs_baseline':c['baseline']['total_cost']-totals['total_cost'],'items':c['sim'].item_summaries()}


if __name__ == '__main__':
    load_default_sample()
    ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
