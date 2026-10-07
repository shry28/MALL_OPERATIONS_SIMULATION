"""Replaceable decision-policy interface and exact full-day implementation."""
from abc import ABC, abstractmethod
from collections import deque

try:
    from .simulation import online_transition, walk_in_transition
except ImportError:  # Script execution inside the backend container.
    from simulation import online_transition, walk_in_transition


class DecisionPolicy(ABC):
    @abstractmethod
    def choose(self, event, simulation):
        """Return item_id -> integer units allocated from shelf for this event."""
        raise NotImplementedError


class ExactDayPolicy(DecisionPolicy):
    """Per-item backward DP; independent shelves make the global problem separable."""
    def __init__(self, items, events):
        self.decisions = {}
        self._rows = {}
        by_item = {x['item_id']: [] for x in items}
        for event in events:
            for line in event['lines']:
                by_item[line['item_id']].append((event, line['qty']))
        for item in items:
            iid = item['item_id']
            rows = by_item[iid]
            capacity = item['initial_shelf_qty']
            pull = item['online_pull_cost_per_unit_paise']
            # V[s] is the minimum future cost with s units at the start of a line.
            value = [0] * (capacity + 1)
            choices = [None] * len(rows)
            for idx in range(len(rows) - 1, -1, -1):
                event, qty = rows[idx]
                nxt = value
                cur = [0] * (capacity + 1)
                if event['type'] == 'walk_in':
                    for shelf in range(1, capacity + 1):
                        next_shelf, _, lost, _, refill_cost = walk_in_transition(item, shelf, qty)
                        cur[shelf] = lost + refill_cost + nxt[next_shelf]
                else:
                    # For partial allocations, minimise V[t] + pull*t over [s-q,s-1].
                    decision = bytearray(capacity + 1)
                    dq = deque()
                    added = 0
                    for shelf in range(1, capacity + 1):
                        hi = shelf - 1
                        while added < hi:
                            added += 1
                            score = nxt[added] + pull * added
                            while dq and dq[-1][1] >= score:
                                dq.pop()
                            dq.append((added, score))
                        lo = max(1, shelf - qty)
                        while dq and dq[0][0] < lo:
                            dq.popleft()
                        next_shelf, _, _, pull_cost, _, refill_cost = online_transition(item, shelf, qty, 0)
                        best = pull_cost + refill_cost + nxt[next_shelf]
                        best_take = 0
                        if qty >= shelf:
                            next_shelf, _, _, pull_cost, _, refill_cost = online_transition(item, shelf, qty, shelf)
                            depleted = pull_cost + refill_cost + nxt[next_shelf]
                            if depleted < best:
                                best, best_take = depleted, shelf
                        if dq:
                            take = shelf - dq[0][0]
                            next_shelf, _, _, pull_cost, _, refill_cost = online_transition(item, shelf, qty, take)
                            candidate = pull_cost + refill_cost + nxt[next_shelf]
                            if candidate < best:
                                best, best_take = candidate, take
                        cur[shelf] = best
                        decision[shelf] = best_take
                    choices[idx] = decision
                value = cur
            self.decisions[iid] = choices
            self._rows[iid] = rows
        self.positions = {item['item_id']: 0 for item in items}

    def choose(self, event, simulation):
        result = {}
        for line in event['lines']:
            iid = line['item_id']
            pos = self.positions[iid]
            row_event, _ = self._rows[iid][pos]
            if row_event['seq'] != event['seq']:
                raise ValueError('policy event sequence mismatch')
            if event['type'] == 'online':
                shelf = simulation.states[iid].shelf
                result[iid] = self.decisions[iid][pos][shelf]
            self.positions[iid] += 1
        return result


def build_policy(items, events):
    """Policy construction seam; HTTP and simulation layers depend on this interface."""
    return ExactDayPolicy(items, events)
