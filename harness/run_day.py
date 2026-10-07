#!/usr/bin/env python3
"""
run_day.py — Harness for Mall Operations Optimiser

Replays a day against a backend service, maintains its own authoritative
simulation, and scores the backend's decisions.

Usage:
    python harness/run_day.py \
        --base-url http://localhost:8080 \
        --items data/items.csv \
        --day days/sample_day_1.json \
        --rate 0 \
        --out results/

Requires Python 3.10+ and `requests`.
"""

import argparse
import csv
import json
import os
import sys
import time
from typing import Any

try:
    import requests
except ImportError:
    print("ERROR: 'requests' library is required. Install with: pip install requests", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Item loader
# ---------------------------------------------------------------------------

def load_items(path: str) -> list[dict]:
    """Load items.csv and return a list of item dicts with integer fields."""
    items = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            items.append({
                "item_id": row["item_id"],
                "name": row["name"],
                "category": row["category"],
                "unit_price_paise": int(row["unit_price_paise"]),
                "initial_shelf_qty": int(row["initial_shelf_qty"]),
                "refill_cost_per_unit_paise": int(row["refill_cost_per_unit_paise"]),
                "online_pull_cost_per_unit_paise": int(row["online_pull_cost_per_unit_paise"]),
            })
    return items


# ---------------------------------------------------------------------------
# Authoritative simulation (single source of truth — same as §2)
# ---------------------------------------------------------------------------

class HarnessSimulation:
    """
    The harness's own authoritative simulation. All costs are computed here;
    the backend's reported totals are NOT used for scoring.
    """

    def __init__(self, items: list[dict]):
        self.items_by_id: dict[str, dict] = {it["item_id"]: it for it in items}
        self.shelf: dict[str, int] = {
            it["item_id"]: it["initial_shelf_qty"] for it in items
        }

        # Accumulators
        self.refill_cost: int = 0
        self.refill_count: int = 0
        self.online_pull_cost: int = 0
        self.lost_revenue: int = 0
        self.units_lost: int = 0
        self.units_pulled_from_inventory: int = 0
        self.walk_in_revenue_captured: int = 0
        self.online_revenue: int = 0
        self.clamped_lines: int = 0

    def _apply_refill(self, item_id: str):
        if self.shelf[item_id] == 0:
            it = self.items_by_id[item_id]
            self.refill_cost += it["initial_shelf_qty"] * it["refill_cost_per_unit_paise"]
            self.refill_count += 1
            self.shelf[item_id] = it["initial_shelf_qty"]

    def process_walk_in(self, event: dict):
        for line in event["lines"]:
            item_id = line["item_id"]
            qty = line["qty"]
            it = self.items_by_id[item_id]
            s = self.shelf[item_id]
            if qty <= s:
                self.shelf[item_id] = s - qty
                self.walk_in_revenue_captured += qty * it["unit_price_paise"]
                self._apply_refill(item_id)
            else:
                self.lost_revenue += qty * it["unit_price_paise"]
                self.units_lost += qty

    def process_online(self, event: dict, response_lines: list[dict] | None):
        """
        Process online event. response_lines is the backend's response
        (list of {item_id, from_shelf}). If None (failure), use from_shelf=0 for all.
        """
        # Build lookup from response
        fs_lookup: dict[str, int] = {}
        if response_lines:
            for rl in response_lines:
                iid = rl.get("item_id", "")
                raw_fs = rl.get("from_shelf")
                # Clamping: missing, null, non-integer → 0
                if raw_fs is None or not isinstance(raw_fs, (int, float)):
                    fs_lookup[iid] = 0
                else:
                    fs_lookup[iid] = int(raw_fs)

        for line in event["lines"]:
            item_id = line["item_id"]
            qty = line["qty"]
            it = self.items_by_id[item_id]
            s = self.shelf[item_id]

            raw_fs = fs_lookup.get(item_id, 0)

            # Clamp: shelf_units = clamp(from_shelf, 0, min(qty, S))
            max_shelf = min(qty, s)
            shelf_units = max(0, min(raw_fs, max_shelf))

            if shelf_units != raw_fs:
                self.clamped_lines += 1

            inventory_units = qty - shelf_units

            self.shelf[item_id] = s - shelf_units
            self.online_pull_cost += inventory_units * it["online_pull_cost_per_unit_paise"]
            self.online_revenue += qty * it["unit_price_paise"]
            self.units_pulled_from_inventory += inventory_units
            self._apply_refill(item_id)

    @property
    def total_cost(self) -> int:
        return self.refill_cost + self.online_pull_cost + self.lost_revenue

    @property
    def gross_revenue(self) -> int:
        return self.walk_in_revenue_captured + self.online_revenue

    def summary(self) -> dict:
        return {
            "refill_cost": self.refill_cost,
            "refill_count": self.refill_count,
            "online_pull_cost": self.online_pull_cost,
            "lost_revenue": self.lost_revenue,
            "total_cost": self.total_cost,
            "units_lost": self.units_lost,
            "units_pulled_from_inventory": self.units_pulled_from_inventory,
            "walk_in_revenue_captured": self.walk_in_revenue_captured,
            "online_revenue": self.online_revenue,
            "gross_revenue": self.gross_revenue,
            "clamped_lines": self.clamped_lines,
        }


# ---------------------------------------------------------------------------
# Harness runner
# ---------------------------------------------------------------------------

def run_day(
    base_url: str,
    items: list[dict],
    day_data: dict,
    rate: int,
    out_dir: str,
    meta: dict | None = None,
):
    day_id = day_data["day_id"]
    events = day_data["events"]
    n_events = len(events)
    api = base_url.rstrip("/") + "/api/v1"

    print(f"=== Running day: {day_id} ({n_events} events) ===")

    # 1. POST /day/load
    print(f"Sending POST {api}/day/load ...")
    load_body = {
        "day_id": day_id,
        "items": items,
        "events": events,
    }

    try:
        resp = requests.post(
            f"{api}/day/load",
            json=load_body,
            timeout=300,
            headers={"Content-Type": "application/json"},
        )
        if resp.status_code != 200:
            print(f"FATAL: /day/load returned {resp.status_code}: {resp.text}")
            write_result(out_dir, day_id, None, 0, n_events, meta, aborted=True)
            return
        load_resp = resp.json()
        print(f"  Load response: {load_resp}")
    except requests.exceptions.Timeout:
        print("FATAL: /day/load timed out (300s)")
        write_result(out_dir, day_id, None, 0, n_events, meta, aborted=True)
        return
    except Exception as e:
        print(f"FATAL: /day/load failed: {e}")
        write_result(out_dir, day_id, None, 0, n_events, meta, aborted=True)
        return

    # 2. Send events one-by-one
    sim = HarnessSimulation(items)
    failures = 0
    consecutive_failures = 0
    total_failures = 0
    aborted = False

    interval = 1.0 / rate if rate > 0 else 0
    start_time = time.time()

    for i, event in enumerate(events):
        seq = event["seq"]

        if rate > 0:
            # Pace the events
            expected_time = start_time + i * interval
            now = time.time()
            if now < expected_time:
                time.sleep(expected_time - now)

        try:
            resp = requests.post(
                f"{api}/day/events",
                json=event,
                timeout=15,
                headers={"Content-Type": "application/json"},
            )

            if resp.status_code != 200:
                # Failure
                consecutive_failures += 1
                total_failures += 1
                if event["type"] == "online":
                    sim.process_online(event, None)  # fallback: from_shelf=0
                else:
                    sim.process_walk_in(event)
            else:
                consecutive_failures = 0
                resp_body = resp.json()

                if event["type"] == "walk_in":
                    sim.process_walk_in(event)
                else:
                    sim.process_online(event, resp_body.get("lines"))

        except requests.exceptions.Timeout:
            consecutive_failures += 1
            total_failures += 1
            if event["type"] == "online":
                sim.process_online(event, None)
            else:
                sim.process_walk_in(event)
        except Exception as e:
            consecutive_failures += 1
            total_failures += 1
            if event["type"] == "online":
                sim.process_online(event, None)
            else:
                sim.process_walk_in(event)

        if consecutive_failures >= 20:
            print(f"\nABORTED: 20 consecutive event failures at seq={seq}")
            aborted = True
            break

        # Progress
        if (i + 1) % 1000 == 0 or i == n_events - 1:
            elapsed = time.time() - start_time
            eps = (i + 1) / elapsed if elapsed > 0 else 0
            print(
                f"\r  Progress: {i+1}/{n_events} "
                f"({100*(i+1)//n_events}%) | "
                f"{eps:.0f} events/s | "
                f"Cost: {sim.total_cost:,} | "
                f"Failures: {total_failures}",
                end="",
                flush=True,
            )

        # Wall-clock cap: 60 minutes
        if time.time() - start_time > 3600:
            print(f"\nABORTED: 60-minute wall-clock cap exceeded at seq={seq}")
            aborted = True
            break

    print()  # newline after progress

    events_processed = seq if not aborted else seq
    write_result(out_dir, day_id, sim, events_processed, n_events, meta, aborted)


def write_result(
    out_dir: str,
    day_id: str,
    sim: "HarnessSimulation | None",
    events_processed: int,
    events_total: int,
    meta: dict | None,
    aborted: bool,
):
    os.makedirs(out_dir, exist_ok=True)

    if aborted or sim is None:
        result = {
            "day_id": day_id,
            "status": "aborted",
            "events_processed": events_processed,
            "events_total": events_total,
            "day_score": 0,
        }
    else:
        summary = sim.summary()
        result = {
            "day_id": day_id,
            "status": "completed",
            "events_processed": events_processed,
            "events_total": events_total,
            "totals": summary,
            "failures": summary.get("failures", 0),
            "clamped_lines": summary["clamped_lines"],
        }

        # Compute day_score if meta available
        if meta:
            c = summary["total_cost"]
            c_base = meta.get("baseline_total_cost", 0)
            c_opt = meta.get("reference_optimal_cost", 0)
            if c_base > c_opt:
                raw_score = (c_base - c) / (c_base - c_opt)
                day_score = 100 * max(0, min(raw_score, 1))
            else:
                day_score = 0
            result["day_score"] = round(day_score, 2)
            result["baseline_total_cost"] = c_base
            result["reference_optimal_cost"] = c_opt
            print(f"  Day score: {day_score:.2f} / 100")

    result_path = os.path.join(out_dir, f"{day_id}.result.json")
    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print(f"  Result written: {result_path}")

    if sim:
        s = sim.summary()
        print(f"\n  === Authoritative Totals ===")
        print(f"  Refill cost:        {s['refill_cost']:>15,} paise")
        print(f"  Online pull cost:   {s['online_pull_cost']:>15,} paise")
        print(f"  Lost revenue:       {s['lost_revenue']:>15,} paise")
        print(f"  ─────────────────────────────────")
        print(f"  TOTAL COST:         {s['total_cost']:>15,} paise")
        print(f"  Gross revenue:      {s['gross_revenue']:>15,} paise")
        print(f"  Refill count:       {s['refill_count']:>15,}")
        print(f"  Units lost:         {s['units_lost']:>15,}")
        print(f"  Units from inv:     {s['units_pulled_from_inventory']:>15,}")
        print(f"  Clamped lines:      {s['clamped_lines']:>15,}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Replay a day against the Mall Operations Optimiser backend."
    )
    parser.add_argument("--base-url", type=str, default="http://localhost:8080",
                        help="Backend base URL (default: http://localhost:8080)")
    parser.add_argument("--items", type=str, required=True,
                        help="Path to items.csv")
    parser.add_argument("--day", type=str, required=True,
                        help="Path to day JSON file")
    parser.add_argument("--rate", type=int, default=0,
                        help="Events per second (0 = max speed)")
    parser.add_argument("--out", type=str, default="results/",
                        help="Output directory for results (default: results/)")

    args = parser.parse_args()

    # Load items
    items = load_items(args.items)
    print(f"Loaded {len(items)} items")

    # Load day
    with open(args.day, "r", encoding="utf-8") as f:
        day_data = json.load(f)
    print(f"Loaded day: {day_data['day_id']} ({len(day_data['events'])} events)")

    # Load meta (if exists)
    meta_path = args.day.replace(".json", ".meta.json")
    meta = None
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        print(f"Loaded meta: {meta_path}")

    # Run
    run_day(args.base_url, items, day_data, args.rate, args.out, meta)


if __name__ == "__main__":
    main()
