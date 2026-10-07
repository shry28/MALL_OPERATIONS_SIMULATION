# Mall Operations Optimiser

An owner dashboard and API for replaying a complete trading day, making online fulfilment decisions, and preserving a searchable event history.

## Run locally with Docker

From this directory:

```sh
docker compose up --build
```

- Dashboard: http://localhost:3000
- API health: http://localhost:8080/api/v1/health
- SQLite database: the persistent `mall-data` Docker volume

On a new install, the backend automatically loads `data/items.csv` with `days/sample_day_1.json`, runs the complete 30,000-event day, and saves its metrics and ledger. The dashboard should show the supplied figures as soon as the first replay finishes. Keep Docker Compose running while using the site; opening `frontend/index.html` directly does not start the API. The dashboard sends API requests through its same-origin Nginx proxy, so it does not need a browser extension or a hard-coded localhost API address. Port 3000 is the required default; if another app already uses it, set `DASHBOARD_PORT=3001` in your local `.env` file.

To try the second supplied day or another dataset, use the dashboard's **Upload files and run the day** controls and choose the catalog CSV and day JSON.

The organiser harness loads a day and streams its events into the API:

```sh
python -m pip install -r harness/requirements.txt
python harness/run_day.py --base-url http://localhost:8080 --items data/items.csv --day days/sample_day_1.json --rate 0 --out results/
```

Use `--rate 50` to watch a paced replay. Repeat for the second sample day without restarting Docker to populate history.

## 1. System architecture and data model

### Stack

- **Backend:** Python 3.12 standard library HTTP server. The event stream is sequential, so a small threaded HTTP layer and a lock around the active simulation make ordering explicit without adding runtime dependencies.
- **Database:** SQLite in WAL mode. It provides transactional day and ledger records, a composite `(day_id, seq)` primary key for ordered history retrieval, and durable storage in a named volume.
- **Frontend:** Static HTML, CSS, and JavaScript served by Nginx. The item catalog has only 50 rows, so direct DOM updates are small; KPI and chart refreshes are batched at one-second intervals rather than on every replay event.

### Data model and write path

`days` stores each day's status, final/current cost fields, load payload, and latest summary. `ledger` stores the original event and response by `(day_id, seq)`. Ledger inserts are committed in batches of 100 events (and at day completion); each batch's summary and status update shares its transaction. History uses the day status and summary, and ledger pagination uses the indexed sequence key.

### UI update path

The dashboard polls the summary API once per second, so page reloads recover current progress from the backend. It requests only the latest 50 rows for live display and fetches older pages on demand for historical review. The backend stores a cumulative policy/baseline chart point every 100 events and at the final event; the cost chart uses those points. KPI cards and the 50 item rows update as one batch per poll.

## 2. Algorithmic decision policy

### Formulation

Items are independent: each item has its own shelf, and a line never changes another item's state. The whole-day objective therefore separates into one finite-horizon dynamic program per item. At load time, each item's event lines are traversed backward. The value function is `V[t, s]`, the minimum remaining pull, refill, and lost-revenue cost at line `t` with `s` units on shelf. Walk-in transitions are forced by the rules. For an online line, the optimizer compares every feasible shelf allocation (including zero and complete depletion/refill) and stores the best action for each shelf state.

The planner has perfect knowledge of future walk-ins and online demand, so it can reserve shelf units for future walk-in lines and avoid a lost line when that is cheaper than the warehouse pull. Revenue from online orders is fixed, while lost walk-in revenue and both warehouse costs are included in the objective.

### Policy, simulator, and complexity

`backend/policy.py` defines the `DecisionPolicy` interface, `ExactDayPolicy`, and the `build_policy` factory. The HTTP layer depends on the factory/interface seam rather than a concrete policy. `backend/simulation.py` contains the shared line-transition functions and live mirror (`Simulation`); both the optimizer and live mirror use those transition functions. The mirror accumulates item and day metrics, and baselines replay through the same simulator.

For `N` total event lines, item shelf capacity `K_i`, and maximum line quantity `Q` (15 here), planning is `O(sum_i N_i * K_i)` time using a sliding minimum for the online transition, and `O(sum_i N_i * K_i)` bytes for compact per-state decisions plus `O(sum_i K_i)` working values. Event processing is `O(lines in event)` and `O(1)` auxiliary memory per line, excluding the persisted ledger record.

### Why it should beat the baselines

Shelf-first never reserves stock for a later walk-in; inventory-only pays for every online unit. Backward planning sees the remaining day's walk-in sequence and uses the shelf when its saved pull cost is worth more than the risk-adjusted future cost, including a possible lost sale. It is exact for the stated rules and input day.

## 3. Sample benchmark results

Both supplied days were replayed end-to-end through `harness/run_day.py --rate 0` against the Docker API. The harness reported zero failed events and zero clamped lines on both days, and its authoritative totals match the reference optima. Load time is measured around the actual `/day/load` HTTP request; throughput is from the harness's full event replay on this Windows Docker Desktop machine.

Sample day 2 has a higher walk-in share (about 65%, versus 50% on day 1), which raises the value of keeping shelf stock available and also produces more lost walk-in revenue. The exact planner accounts for the full future sequence, so it reaches the supplied optimum on both traffic mixes; the larger savings on day 2 come from its much more expensive baselines.

| Metric | Sample day 1 | Sample day 2 |
|---|---:|---:|
| Events (walk-in / online) | 30,000 (15,082 / 14,918) | 35,000 (22,740 / 12,260) |
| Event lines / most popular item | 69,982 / I026 (9,359 lines) | 81,710 / I025 (10,959 lines) |
| Refill cost (paise) | 777,272,500 | 974,970,200 |
| Online pull cost (paise) | 177,687,600 | 223,612,650 |
| Lost revenue (paise) | 18,324,800 | 155,393,100 |
| Total cost (paise) | **973,284,900** | **1,353,975,950** |
| Baseline cost (paise) | 2,485,934,450 | 4,431,194,650 |
| Reference optimum (paise) | 973,284,900 | 1,353,975,950 |
| Savings vs baseline (paise) | 1,512,649,550 | 3,077,218,700 |
| Score vs supplied reference | **100 / 100** | **100 / 100** |
| `/day/load` time | 6.579 s | 4.348 s |
| Harness throughput | 51 events/s | 51 events/s |
| Event failures / clamped lines | 0 / 0 | 0 / 0 |

The full harness result files are `results/sample_day_1.result.json` and `results/sample_day_2.result.json`. Set `PYTHONIOENCODING=utf-8` when invoking the harness from Windows PowerShell.

A separate live-viewing run of sample day 1 at `--rate 50` also completed all 30,000 events with zero failures and zero clamped lines (about 48 events/s on this Windows Docker Desktop host). While it ran, the dashboard summary endpoint advanced live and the page remained available.

Run the rule tests from this directory with:

```sh
python -m unittest discover -s backend/tests -v
```

## 4. Modularity and live interview changes

- **HTTP/API:** `backend/server.py`
- **Simulation and metrics:** `backend/simulation.py`
- **Decision policy:** `backend/policy.py` (`DecisionPolicy`, `ExactDayPolicy`, `build_policy`)
- **Persistence:** `backend/storage.py`
- **Dashboard:** `frontend/index.html`, `frontend/app.js`, and `frontend/style.css`

For a refill threshold variation, change the shared transition functions in `backend/simulation.py` and the planner state range if the new threshold introduces additional shelf states. For partial online fulfilment, extend `online_transition`, the policy, and line metrics. For a fixed refill batch, change the refill quantity in the shared transition function. The HTTP and database layers can stay unchanged.
