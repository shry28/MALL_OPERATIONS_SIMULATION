import itertools
import unittest

from backend.policy import ExactDayPolicy
from backend.simulation import Simulation


def item():
    return {
        'item_id': 'A', 'name': 'Test item', 'unit_price_paise': 100,
        'initial_shelf_qty': 5, 'refill_cost_per_unit_paise': 10,
        'online_pull_cost_per_unit_paise': 15,
    }


class SimulationTests(unittest.TestCase):
    def test_worked_example_costs_and_state(self):
        sim = Simulation([item()])
        events = [
            {'seq': 1, 'type': 'walk_in', 'lines': [{'item_id': 'A', 'qty': 3}]},
            {'seq': 2, 'type': 'online', 'lines': [{'item_id': 'A', 'qty': 4}]},
            {'seq': 3, 'type': 'walk_in', 'lines': [{'item_id': 'A', 'qty': 6}]},
            {'seq': 4, 'type': 'walk_in', 'lines': [{'item_id': 'A', 'qty': 5}]},
        ]
        for event, route in zip(events, [None, {'A': 2}, None, None]):
            sim.apply(event, route)
        self.assertEqual(sim.summary_totals(), {
            'refill_cost': 100, 'online_pull_cost': 30, 'lost_revenue': 600,
            'refill_count': 2, 'units_lost': 6, 'units_pulled_from_inventory': 2,
            'walk_in_revenue_captured': 800, 'online_revenue': 400,
            'gross_revenue': 1200, 'total_cost': 730,
        })
        self.assertEqual(sim.states['A'].shelf, 5)

    def test_online_split_clamps_to_valid_shelf_allocation(self):
        sim = Simulation([item()])
        event = {'seq': 1, 'type': 'online', 'lines': [{'item_id': 'A', 'qty': 2}]}
        self.assertEqual(sim.apply(event, {'A': 99}), [{'item_id': 'A', 'from_shelf': 2}])
        self.assertEqual(sim.states['A'].shelf, 3)
        sim = Simulation([item()])
        self.assertEqual(sim.apply(event, {'A': -4}), [{'item_id': 'A', 'from_shelf': 0}])
        self.assertEqual(sim.states['A'].shelf, 5)
        for invalid in (None, 1.5, '2', True):
            sim = Simulation([item()])
            self.assertEqual(sim.apply(event, {'A': invalid}), [{'item_id': 'A', 'from_shelf': 0}])
        sim = Simulation([item()])
        self.assertEqual(sim.apply(event, {}), [{'item_id': 'A', 'from_shelf': 0}])

    def test_policy_matches_exhaustive_optimum_on_small_day(self):
        events = [
            {'seq': 1, 'type': 'walk_in', 'lines': [{'item_id': 'A', 'qty': 3}]},
            {'seq': 2, 'type': 'online', 'lines': [{'item_id': 'A', 'qty': 4}]},
            {'seq': 3, 'type': 'walk_in', 'lines': [{'item_id': 'A', 'qty': 4}]},
            {'seq': 4, 'type': 'online', 'lines': [{'item_id': 'A', 'qty': 3}]},
            {'seq': 5, 'type': 'walk_in', 'lines': [{'item_id': 'A', 'qty': 6}]},
        ]
        policy = ExactDayPolicy([item()], events)
        sim = Simulation([item()])
        for event in events:
            route = policy.choose(event, sim)
            sim.apply(event, route)

        online_indices = [i for i, event in enumerate(events) if event['type'] == 'online']
        best = None
        for actions in itertools.product(range(5), repeat=len(online_indices)):
            candidate = Simulation([item()])
            action_at = dict(zip(online_indices, actions))
            for i, event in enumerate(events):
                requested = action_at.get(i, 0)
                candidate.apply(event, {'A': requested} if event['type'] == 'online' else None)
            cost = candidate.summary_totals()['total_cost']
            best = cost if best is None else min(best, cost)
        self.assertEqual(sim.summary_totals()['total_cost'], best)


if __name__ == '__main__':
    unittest.main()
