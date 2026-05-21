# Airport ATC MCP Server

A Model Context Protocol (MCP) server that acts as an AI-ready Air Traffic Control system. It accepts flight plans, schedules arrivals and departures across limited airport resources, handles dependency chains between flights, and exposes the airport state to MCP-compatible AI clients.

---

## Installation & Build

**Requirements:** Node.js ≥ 18

```bash
cd task-4
npm install
npm run build
```

The compiled output lands in `dist/`.

---

## Environment Variables

All airport limits are loaded from environment variables at startup. The server fails immediately with a clear error if any required variable is missing or invalid.

### Required

| Variable | Type | Description |
|----------|------|-------------|
| `RUNWAY_COUNT` | integer ≥ 1 | Number of runways |
| `GATE_COUNT` | integer ≥ 1 | Number of gates |
| `GROUND_CREW_COUNT` | integer ≥ 1 | Maximum concurrent operations (crew limit) |
| `RUNWAY_SEPARATION_TAKEOFF` | integer ≥ 0 | Minutes between consecutive takeoffs on the same runway |
| `RUNWAY_SEPARATION_LANDING` | integer ≥ 0 | Minutes between consecutive landings on the same runway |
| `RUNWAY_SEPARATION_MIXED` | integer ≥ 0 | Minutes between a takeoff and landing (or vice versa) on the same runway |
| `GATE_TURNAROUND_TIME` | integer ≥ 0 | Extra minutes a gate stays occupied after an operation ends |
| `DEPENDENCY_BUFFER_TIME` | integer ≥ 0 | Minimum minutes between a dependency flight completing and its dependent starting |
| `MAX_SCHEDULING_HORIZON` | integer ≥ 1 | Maximum number of minutes from schedule epoch within which flights can be placed |

### Optional

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `RUNWAY_LENGTHS` | comma-separated integers | 3000 for each runway | Length in meters of each runway. Must contain exactly `RUNWAY_COUNT` values when set. Used to reject flights whose `runwayRequirement` exceeds all available runway lengths. |
| `ARRIVAL_DURATION` | integer ≥ 1 | 15 | Minutes an arrival operation occupies a runway (landing + taxi) |
| `DEPARTURE_DURATION` | integer ≥ 1 | 20 | Minutes a departure operation occupies a runway (pushback + taxi + takeoff) |

### Example `.env`

```dotenv
RUNWAY_COUNT=2
GATE_COUNT=4
GROUND_CREW_COUNT=3
RUNWAY_SEPARATION_TAKEOFF=2
RUNWAY_SEPARATION_LANDING=3
RUNWAY_SEPARATION_MIXED=4
GATE_TURNAROUND_TIME=30
DEPENDENCY_BUFFER_TIME=15
MAX_SCHEDULING_HORIZON=480
RUNWAY_LENGTHS=3000,2500
```

---

## Running the Server

The server communicates over **stdio** (standard MCP transport).

### Direct

```bash
export RUNWAY_COUNT=2
export GATE_COUNT=4
export GROUND_CREW_COUNT=3
export RUNWAY_SEPARATION_TAKEOFF=2
export RUNWAY_SEPARATION_LANDING=3
export RUNWAY_SEPARATION_MIXED=4
export GATE_TURNAROUND_TIME=30
export DEPENDENCY_BUFFER_TIME=15
export MAX_SCHEDULING_HORIZON=480
node dist/index.js
```

### With a `.env` file via dotenvx / direnv

```bash
dotenvx run -- node dist/index.js
```

---

## Connecting from an MCP-Compatible Client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "airport-atc": {
      "command": "node",
      "args": ["/absolute/path/to/task-4/dist/index.js"],
      "env": {
        "RUNWAY_COUNT": "2",
        "GATE_COUNT": "4",
        "GROUND_CREW_COUNT": "3",
        "RUNWAY_SEPARATION_TAKEOFF": "2",
        "RUNWAY_SEPARATION_LANDING": "3",
        "RUNWAY_SEPARATION_MIXED": "4",
        "GATE_TURNAROUND_TIME": "30",
        "DEPENDENCY_BUFFER_TIME": "15",
        "MAX_SCHEDULING_HORIZON": "480",
        "RUNWAY_LENGTHS": "3000,2500"
      }
    }
  }
}
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "airport-atc": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/task-4/dist/index.js"],
      "env": {
        "RUNWAY_COUNT": "2",
        "GATE_COUNT": "4",
        "GROUND_CREW_COUNT": "3",
        "RUNWAY_SEPARATION_TAKEOFF": "2",
        "RUNWAY_SEPARATION_LANDING": "3",
        "RUNWAY_SEPARATION_MIXED": "4",
        "GATE_TURNAROUND_TIME": "30",
        "DEPENDENCY_BUFFER_TIME": "15",
        "MAX_SCHEDULING_HORIZON": "480"
      }
    }
  }
}
```

---

## Tools Reference

### `submit_flight`

Submit a new arrival or departure to the airport queue.

**Input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `flightNumber` | string | yes | Unique identifier, uppercase alphanumeric (e.g. `AA123`) |
| `operationType` | `"arrival"` \| `"departure"` | yes | Inbound or outbound operation |
| `priority` | `"high"` \| `"medium"` \| `"low"` | yes | Scheduling priority — high is scheduled earlier when resources are contested |
| `dependencies` | string[] | no | Flight numbers that must complete before this flight can start |
| `runwayRequirement` | number (meters) | no | Minimum runway length required; the flight is marked unschedulable if no runway qualifies |

**Returns** Confirmation message with the submitted flight details, or an error if the flight number already exists.

---

### `generate_schedule`

Compute a fresh schedule from the current flight queue and airport configuration. Replaces any existing schedule. All non-cancelled flights are re-evaluated from scratch.

**Input** None.

**Returns** Schedule epoch timestamp, count of scheduled/unscheduled flights, list of scheduled flight numbers, and details (flight number + reason) for each unschedulable flight.

---

### `get_airport_status`

Return a structured operational snapshot of the current airport state.

**Input** None.

**Returns**
- `scheduleEpoch` — timestamp of the last `generate_schedule` call
- `scheduleCompletionTime` — absolute timestamp when the last scheduled operation ends
- `flightCounts` — total, scheduled, unscheduled, cancelled; broken down by arrivals/departures
- `runways` — per-runway scheduled operation count and configured length
- `gates` — per-gate scheduled operation count and overall utilisation ratio
- `groundCrew` — total crew count and peak concurrent usage
- `resourceConstraints` — human-readable warnings when resources are fully utilised
- `unscheduledFlights` — list of unschedulable flights with their reasons

---

### `cancel_flight`

Cancel a flight by flight number. Removes it from the current schedule, then cascades: all flights that (directly or transitively) depend on the cancelled flight are marked `unscheduled`. A full reschedule is then triggered automatically so that affected flights are re-evaluated immediately.

**Input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `flightNumber` | string | yes | Flight to cancel |

**Returns** Success flag, cancelled flight number, list of transitively affected flight numbers, and a `rescheduleSummary` with the results of the automatic reschedule.

---

### `analyze_bottleneck`

Identify the longest active scheduled dependency chain (the chain that drives the total schedule duration).

**Input** None.

**Returns**
- `longestDependencyChain` — ordered list of flight numbers in the bottleneck chain
- `totalDurationMinutes` — elapsed time from the first flight's start to the last flight's end, including operation durations and dependency buffer gaps
- `chain` — per-flight detail with absolute start/end timestamps

Returns a message if no dependency chains exist among scheduled flights.

---

## Resources Reference

### `airport://flight-queue`

All flights in the system regardless of status.

**Fields per flight:** `flightNumber`, `operationType`, `priority`, `status` (`unscheduled` | `scheduled` | `cancelled`), `dependencies`, `runwayRequirement`, `submittedAt`, `scheduledStartMin`, `scheduledEndMin`, `scheduledStartTime`, `scheduledEndTime`, `scheduledRunway`, `scheduledGate`, `unscheduledReason`.

Also includes a `summary` object with total/scheduled/unscheduled/cancelled counts.

---

### `airport://runway-availability`

Per-runway configuration and scheduled operations.

**Fields:** `runwayIndex` (1-based), `lengthMeters`, `scheduledOperations` (list with flight number, operation type, start/end minutes and absolute timestamps), `totalOccupiedMinutes`. Also includes the configured separation buffer values.

---

### `airport://operations-timeline`

Chronological list of all currently scheduled operations.

**Fields per entry:** `flightNumber`, `operationType`, `priority`, `startMin`, `endMin`, `startTime` (ISO), `endTime` (ISO), `runway` (1-based), `gate` (1-based), `dependencies`. Sorted by `startMin` ascending, then alphabetically by flight number for ties. Also includes `scheduleEpoch` and `totalOperations`.
