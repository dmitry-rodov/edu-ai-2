# Report: Airport ATC MCP Server

## Scheduling Approach

### Algorithm

The scheduler uses a **priority-based greedy algorithm** with iterative dependency resolution.

**Phase 1 — Dependency resolution loop**

All non-cancelled flights start in a `pending` pool. On each iteration the algorithm collects every pending flight whose dependencies are either scheduled, cancelled, or unknown (ignored), then sorts that "ready" set by priority (`high` → `medium` → `low`) and submission timestamp (for determinism within the same priority). Each flight in that sorted batch is then passed to the slot-finder. Once a flight is marked `scheduled` or `unschedulable`, it is removed from the pending pool and becomes available to unblock its dependents in future iterations. The loop continues until no pending flights remain ready or no progress was made (circular/blocked deps).

This design ensures that high-priority flights always get first pick of early time slots while still respecting explicit ordering imposed by dependencies.

**Phase 2 — Slot finder (per flight)**

For a given flight the slot finder:

1. Checks that at least one runway satisfies the flight's `runwayRequirement`. If none do, the flight is immediately marked unschedulable with a human-readable reason listing available lengths.
2. Computes the earliest start minute as the maximum of zero and `(dependency.scheduledEndMin + DEPENDENCY_BUFFER_TIME)` across all scheduled dependencies.
3. Iterates minute-by-minute from that earliest start up to `MAX_SCHEDULING_HORIZON`, trying each eligible runway in order. For each candidate (time, runway) pair it checks:
   - **Runway separation** — the proposed window must not overlap any existing slot and must clear the configured separation buffer before and after neighbouring operations (takeoff/landing/mixed buffers applied correctly).
   - **Gate availability** — a gate must be free for the operation duration plus `GATE_TURNAROUND_TIME`.
   - **Ground crew** — the number of concurrent operations at any point in the proposed window must be below `GROUND_CREW_COUNT`.
4. The first valid (time, runway, gate) triple is assigned; the flight is marked `scheduled` and the resources are booked.

**Determinism** — All inputs to the sort (priority enum value, ISO submission timestamp) are stable and config-independent, so identical inputs produce identical schedules regardless of call order.

### Dependency Buffer Semantics

The buffer is additive: if flight B depends on flight A and A ends at minute 33, B cannot start before minute `33 + DEPENDENCY_BUFFER_TIME`. This models the real-world need for connecting passengers or cargo to transfer between aircraft.

### Cancellation Cascade

When a flight is cancelled its runway, gate, and ground crew slots are removed from the in-memory state. The algorithm then performs a breadth-first traversal of the dependency graph, marking every transitively dependent flight `unscheduled` and clearing their slots. A full `generateSchedule` is then called automatically, so affected flights are re-evaluated and rescheduled immediately without requiring a separate client call.

### Bottleneck Analysis

The bottleneck algorithm runs a topological sort over the subgraph of scheduled flights and computes the longest weighted path using dynamic programming. The path weight is wall-clock elapsed time (`last.scheduledEndMin − first.scheduledStartMin`), which naturally includes operation durations and any dependency buffer gaps. Only multi-flight chains are reported; single isolated flights are not bottlenecks.

---

## Key Design Decisions

**Greedy over optimal** — A full constraint-satisfaction or integer-linear-programming approach would produce a globally optimal schedule but would be complex to implement correctly and difficult to reason about. The greedy priority-first approach is simpler, predictable, and sufficient for the validation scenarios. Its main limitation is that it may not always find a valid schedule when one exists (e.g., reordering two equal-priority flights might free a resource), but this is an acceptable trade-off given the task scope.

**Minute-granularity time model** — All times are represented as integer minutes from the schedule epoch. This avoids floating-point edge cases and keeps the resource-conflict logic straightforward. The granularity is fine enough for realistic airport operations.

**In-memory state** — The airport state is a plain JavaScript `Map` and arrays. There is no database. This keeps the server stateless across restarts (intentional — the server is meant to be used in a single session), and makes the implementation simple and fast.

**Environment-variable configuration with Zod** — Using Zod for the config schema means validation errors surface immediately at startup with field-level messages rather than later at runtime with cryptic crashes.

**Runway lengths default** — If `RUNWAY_LENGTHS` is not set, all runways default to 3 000 m. This is a safe, explicit default that lets the server start without the variable while still supporting the Heavy Hauler scenario when the variable is provided.

**Gate occupancy model** — Both arrivals and departures occupy a gate for `operationDuration + GATE_TURNAROUND_TIME`. For arrivals this models the aircraft sitting at the gate after landing; for departures it models the pre-departure gate time. This is a simplification (in reality arrivals and departures have different gate-occupancy patterns) but it is consistent and easy to reason about.

---

## Tools and Techniques

- **TypeScript** — strict mode, `Node16` module resolution, ESM output.
- **`@modelcontextprotocol/sdk` v1** — official MCP server SDK; handles JSON-RPC framing, capability negotiation, and stdio transport.
- **Zod** — runtime schema validation for both configuration and tool inputs.
- **Sweep-line algorithm** — used in `computePeakConcurrentUsage` for the `get_airport_status` ground-crew metric; runs in O(n log n) on the usage intervals.

---

## What Worked

- The iterative dependency resolution loop correctly handles arbitrary DAG shapes, including flights that depend on flights that themselves depend on others.
- Priority-based ordering within the ready set reliably gives high-priority flights earlier time slots across all tested scenarios.
- The minute-by-minute slot search is simple to reason about and easy to extend (e.g., to add noise/weather delays as an offset).
- The cancellation cascade correctly propagates through multi-level dependency trees.
- All three validation scenarios pass on first run without any special-casing.

## What Did Not Work / Limitations

- **Greedy is not optimal** — in heavily constrained scenarios with many flights of equal priority, the order in which ready flights are tried can lead to suboptimal schedules. A backtracking or beam-search approach would improve utilisation at the cost of complexity.
- **Minute-by-minute search is O(H × R × G)** per flight (H = horizon, R = runways, G = gates). For very large horizons or many flights this becomes slow. A smarter approach would build an event-driven timeline and jump to the next candidate time directly.
- **No persistence** — restarting the server clears all state. Adding a simple JSON file snapshot would make it more usable in practice.
- **Gate model is symmetric** — the current model treats gate occupancy the same for arrivals and departures. A more realistic model would separate gate-in (arrival) from gate-out (departure) time windows.
- **Full reschedule on cancel** — `cancel_flight` triggers a complete `generateSchedule` to re-evaluate affected flights. This is simple and correct but rebuilds the entire schedule from scratch rather than incrementally rescheduling only the affected flights.
