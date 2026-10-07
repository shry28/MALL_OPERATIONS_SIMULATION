"""Authoritative shelf transition functions, mirror state, and metrics."""
from dataclasses import dataclass


def walk_in_transition(item, shelf, qty):
    """Apply one walk-in line under the normative all-or-nothing rule."""
    if qty <= shelf:
        next_shelf = shelf - qty
        captured = qty * item['unit_price_paise']
        lost = 0
    else:
        next_shelf = shelf
        captured = 0
        lost = qty * item['unit_price_paise']
    refill_count = 0
    refill_cost = 0
    if qty <= shelf and next_shelf == 0:
        next_shelf = item['initial_shelf_qty']
        refill_count = 1
        refill_cost = next_shelf * item['refill_cost_per_unit_paise']
    return next_shelf, captured, lost, refill_count, refill_cost


def online_transition(item, shelf, qty, requested):
    """Clamp an online allocation, apply depletion/refill, and return line deltas."""
    if not isinstance(requested, int) or isinstance(requested, bool):
        requested = 0
    taken = max(0, min(requested, qty, shelf))
    inventory = qty - taken
    next_shelf = shelf - taken
    pull_cost = inventory * item['online_pull_cost_per_unit_paise']
    refill_count = 0
    refill_cost = 0
    if next_shelf == 0:
        next_shelf = item['initial_shelf_qty']
        refill_count = 1
        refill_cost = next_shelf * item['refill_cost_per_unit_paise']
    return next_shelf, taken, inventory, pull_cost, refill_count, refill_cost


@dataclass
class ItemState:
    item: dict
    shelf: int
    refill_count: int = 0
    units_lost: int = 0
    lost_revenue: int = 0
    units_pulled: int = 0
    pull_cost: int = 0
    refill_cost: int = 0


class Simulation:
    def __init__(self, items):
        self.states = {x['item_id']: ItemState(x, x['initial_shelf_qty']) for x in items}
        self.totals = dict(refill_cost=0, online_pull_cost=0, lost_revenue=0,
                           refill_count=0, units_lost=0, units_pulled_from_inventory=0,
                           walk_in_revenue_captured=0, online_revenue=0)

    def apply(self, event, from_shelf=None):
        routes = []
        for line in event['lines']:
            state = self.states[line['item_id']]
            item, qty = state.item, line['qty']
            if event['type'] == 'walk_in':
                state.shelf, captured, lost, refills, refill_cost = walk_in_transition(item, state.shelf, qty)
                self.totals['walk_in_revenue_captured'] += captured
                state.units_lost += qty if lost else 0
                state.lost_revenue += lost
                self.totals['units_lost'] += qty if lost else 0
                self.totals['lost_revenue'] += lost
                state.refill_count += refills
                state.refill_cost += refill_cost
                self.totals['refill_count'] += refills
                self.totals['refill_cost'] += refill_cost
            else:
                requested = (from_shelf or {}).get(item['item_id'], 0)
                state.shelf, taken, inventory, cost, refills, refill_cost = online_transition(item, state.shelf, qty, requested)
                state.units_pulled += inventory
                state.pull_cost += cost
                self.totals['units_pulled_from_inventory'] += inventory
                self.totals['online_pull_cost'] += cost
                self.totals['online_revenue'] += qty * item['unit_price_paise']
                routes.append({'item_id': item['item_id'], 'from_shelf': taken})
                state.refill_count += refills
                state.refill_cost += refill_cost
                self.totals['refill_count'] += refills
                self.totals['refill_cost'] += refill_cost
        return routes

    def summary_totals(self):
        t = self.totals.copy()
        t['gross_revenue'] = t['walk_in_revenue_captured'] + t['online_revenue']
        t['total_cost'] = t['refill_cost'] + t['online_pull_cost'] + t['lost_revenue']
        return t

    def item_summaries(self):
        return [dict(item_id=s.item['item_id'], name=s.item.get('name', s.item['item_id']), shelf_qty=s.shelf, refill_count=s.refill_count,
                     units_lost=s.units_lost, lost_revenue=s.lost_revenue,
                     units_pulled=s.units_pulled, pull_cost=s.pull_cost, refill_cost=s.refill_cost)
                for s in self.states.values()]
