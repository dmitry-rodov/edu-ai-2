import {
  type Flight,
  type AirportState,
  type RunwayState,
  type GateState,
  type OperationType,
} from './types.js';
import { type Config } from './config.js';
import { getState } from './state.js';

// ---------------------------------------------------------------------------
// Schedule generation
// ---------------------------------------------------------------------------

export interface ScheduleResult {
  scheduleEpoch: string;
  scheduledCount: number;
  unscheduledCount: number;
  scheduledFlights: string[];
  unscheduledFlights: { flightNumber: string; reason: string }[];
}

export function generateSchedule(config: Config): ScheduleResult {
  const state = getState();
  const epoch = new Date().toISOString();
  state.scheduleEpoch = epoch;

  // Reset resource usage
  for (const runway of state.runways) runway.slots = [];
  for (const gate of state.gates) gate.slots = [];
  state.groundCrewUsage = [];

  // Collect non-cancelled flights and reset their scheduled state
  const activeFlights = [...state.flights.values()].filter((f) => f.status !== 'cancelled');
  for (const f of activeFlights) {
    f.status = 'unscheduled';
    f.scheduledStartMin = undefined;
    f.scheduledEndMin = undefined;
    f.scheduledRunway = undefined;
    f.scheduledGate = undefined;
    f.unscheduledReason = undefined;
  }

  const flightMap = state.flights;
  const scheduledIds = new Set<string>();
  const unschedulableIds = new Set<string>();
  const pendingIds = new Set<string>(activeFlights.map((f) => f.flightNumber));

  // Iteratively schedule flights whose dependencies are resolved.
  // On each pass, collect all "ready" flights, sort by priority + submission
  // order, then attempt to schedule them. Repeat until no progress.
  let madeProgress = true;
  while (madeProgress && pendingIds.size > 0) {
    madeProgress = false;

    const ready: Flight[] = [];
    for (const id of pendingIds) {
      const flight = flightMap.get(id)!;
      if (areDepsResolved(flight, flightMap, scheduledIds, unschedulableIds)) {
        ready.push(flight);
      }
    }

    if (ready.length === 0) break;

    // Stable sort: priority first, then submission time for determinism
    ready.sort((a, b) => {
      const diff = priorityValue(a.priority) - priorityValue(b.priority);
      if (diff !== 0) return diff;
      return a.submittedAt.localeCompare(b.submittedAt);
    });

    for (const flight of ready) {
      pendingIds.delete(flight.flightNumber);
      madeProgress = true;

      const result = tryScheduleFlight(flight, flightMap, scheduledIds, state, config);
      if (result.success) {
        scheduledIds.add(flight.flightNumber);
        flight.status = 'scheduled';
      } else {
        unschedulableIds.add(flight.flightNumber);
        flight.status = 'unscheduled';
        flight.unscheduledReason = result.reason;
      }
    }
  }

  // Remaining pending flights are blocked by unresolvable / circular deps
  for (const id of pendingIds) {
    const flight = flightMap.get(id)!;
    flight.status = 'unscheduled';
    const blockedBy = flight.dependencies.find((dep) => unschedulableIds.has(dep));
    flight.unscheduledReason = blockedBy
      ? `Dependency unschedulable: ${blockedBy}`
      : 'Circular or unresolvable dependency';
    unschedulableIds.add(id);
  }

  const unscheduledFlights = [...unschedulableIds].map((id) => {
    const f = flightMap.get(id)!;
    return { flightNumber: id, reason: f.unscheduledReason ?? 'Unknown reason' };
  });

  return {
    scheduleEpoch: epoch,
    scheduledCount: scheduledIds.size,
    unscheduledCount: unschedulableIds.size,
    scheduledFlights: [...scheduledIds],
    unscheduledFlights,
  };
}

// ---------------------------------------------------------------------------
// Cancel a flight and cascade to dependents
// ---------------------------------------------------------------------------

export interface CancelResult {
  success: boolean;
  reason?: string;
  cancelledFlight?: string;
  affectedFlights?: string[];
  rescheduleSummary?: ScheduleResult;
}

export function cancelFlight(flightNumber: string, config: Config): CancelResult {
  const state = getState();
  const flight = state.flights.get(flightNumber);

  if (!flight) {
    return { success: false, reason: 'Flight not found' };
  }
  if (flight.status === 'cancelled') {
    return { success: false, reason: 'Flight is already cancelled' };
  }

  removeFlightSlots(flight, state);
  flight.status = 'cancelled';
  flight.scheduledStartMin = undefined;
  flight.scheduledEndMin = undefined;
  flight.scheduledRunway = undefined;
  flight.scheduledGate = undefined;

  // Cascade: mark all transitive dependents as unscheduled
  const affected: string[] = [];
  const toProcess = [flightNumber];

  while (toProcess.length > 0) {
    const currentId = toProcess.shift()!;
    for (const [, f] of state.flights) {
      if (f.status === 'cancelled') continue;
      if (!f.dependencies.includes(currentId)) continue;
      if (affected.includes(f.flightNumber)) continue;

      if (f.status === 'scheduled') {
        removeFlightSlots(f, state);
      }

      affected.push(f.flightNumber);
      f.status = 'unscheduled';
      f.unscheduledReason = `Dependency ${currentId} was cancelled`;
      f.scheduledStartMin = undefined;
      f.scheduledEndMin = undefined;
      f.scheduledRunway = undefined;
      f.scheduledGate = undefined;
      toProcess.push(f.flightNumber);
    }
  }

  // Re-evaluate the schedule so affected flights are rescheduled automatically
  const rescheduleSummary = generateSchedule(config);

  return {
    success: true,
    cancelledFlight: flightNumber,
    affectedFlights: affected,
    rescheduleSummary,
  };
}

// ---------------------------------------------------------------------------
// Bottleneck analysis — longest scheduled dependency chain
// ---------------------------------------------------------------------------

export interface BottleneckResult {
  chain: string[];
  totalDurationMinutes: number;
  chainDetails: Array<{
    flightNumber: string;
    operationType: string;
    startMin: number;
    endMin: number;
  }>;
}

export function analyzeBottleneck(): BottleneckResult | null {
  const state = getState();
  const scheduled = [...state.flights.values()].filter((f) => f.status === 'scheduled');

  if (scheduled.length === 0) return null;

  // Topological sort of scheduled flights respecting explicit dependencies
  const topoOrder = topologicalSort(scheduled, state.flights);

  // DP: for each flight, compute the longest chain ending at that flight
  const chainFor = new Map<string, Flight[]>();

  for (const flight of topoOrder) {
    let bestChain: Flight[] = [flight];
    let bestDuration =
      (flight.scheduledEndMin ?? 0) - (flight.scheduledStartMin ?? 0);

    for (const depId of flight.dependencies) {
      const dep = state.flights.get(depId);
      if (!dep || dep.status !== 'scheduled') continue;

      const depChain = chainFor.get(depId) ?? [dep];
      const chainDuration =
        (flight.scheduledEndMin ?? 0) - (depChain[0].scheduledStartMin ?? 0);

      if (chainDuration > bestDuration) {
        bestChain = [...depChain, flight];
        bestDuration = chainDuration;
      }
    }

    chainFor.set(flight.flightNumber, bestChain);
  }

  // Find the overall longest multi-flight chain
  let longestChain: Flight[] = [];
  let longestDuration = 0;

  for (const [, chain] of chainFor) {
    if (chain.length < 2) continue; // single-flight chains are not bottlenecks
    const duration =
      (chain[chain.length - 1].scheduledEndMin ?? 0) -
      (chain[0].scheduledStartMin ?? 0);
    if (duration > longestDuration) {
      longestDuration = duration;
      longestChain = chain;
    }
  }

  if (longestChain.length === 0) return null;

  return {
    chain: longestChain.map((f) => f.flightNumber),
    totalDurationMinutes: longestDuration,
    chainDetails: longestChain.map((f) => ({
      flightNumber: f.flightNumber,
      operationType: f.operationType,
      startMin: f.scheduledStartMin ?? 0,
      endMin: f.scheduledEndMin ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function areDepsResolved(
  flight: Flight,
  flightMap: Map<string, Flight>,
  scheduledIds: Set<string>,
  unschedulableIds: Set<string>
): boolean {
  for (const dep of flight.dependencies) {
    const depFlight = flightMap.get(dep);
    if (!depFlight) continue; // unknown dep — ignore
    if (depFlight.status === 'cancelled') continue; // cancelled is OK
    if (scheduledIds.has(dep)) continue; // scheduled is OK
    if (unschedulableIds.has(dep)) return false; // blocked
    return false; // still pending
  }
  return true;
}

function priorityValue(p: string): number {
  if (p === 'high') return 0;
  if (p === 'medium') return 1;
  return 2;
}

interface TryScheduleResult {
  success: boolean;
  reason: string;
}

function tryScheduleFlight(
  flight: Flight,
  flightMap: Map<string, Flight>,
  _scheduledIds: Set<string>,
  state: AirportState,
  config: Config
): TryScheduleResult {
  // 1. Runway requirements check
  const eligibleRunways = state.runways.filter(
    (r) =>
      flight.runwayRequirement === undefined || r.length >= flight.runwayRequirement
  );
  if (eligibleRunways.length === 0) {
    const available = state.runways.map((r) => `R${r.index + 1}=${r.length}m`).join(', ');
    return {
      success: false,
      reason: `No runway meets the required length of ${flight.runwayRequirement}m (available: ${available})`,
    };
  }

  // 2. Earliest start from dependencies
  let earliestStart = 0;
  for (const dep of flight.dependencies) {
    const depFlight = flightMap.get(dep);
    if (!depFlight || depFlight.status === 'cancelled') continue;
    if (depFlight.scheduledEndMin !== undefined) {
      earliestStart = Math.max(
        earliestStart,
        depFlight.scheduledEndMin + config.dependencyBuffer
      );
    }
  }

  const duration =
    flight.operationType === 'arrival'
      ? config.arrivalDuration
      : config.departureDuration;

  // 3. Greedy slot search
  for (
    let t = earliestStart;
    t + duration <= config.maxSchedulingHorizon;
    t++
  ) {
    for (const runway of eligibleRunways) {
      if (!isRunwayAvailable(runway, t, duration, flight.operationType, config)) {
        continue;
      }

      // Gate occupancy = operation duration + turnaround time
      const gateOccupancy = duration + config.gateTurnaroundTime;
      const gateIndex = findAvailableGate(state.gates, t, gateOccupancy);
      if (gateIndex === -1) continue;

      if (
        !isGroundCrewAvailable(
          state.groundCrewUsage,
          t,
          duration,
          config.groundCrewCount
        )
      ) {
        continue;
      }

      // Assign
      flight.scheduledStartMin = t;
      flight.scheduledEndMin = t + duration;
      flight.scheduledRunway = runway.index;
      flight.scheduledGate = gateIndex;

      runway.slots.push({
        flightNumber: flight.flightNumber,
        operationType: flight.operationType,
        startMin: t,
        endMin: t + duration,
      });

      state.gates[gateIndex].slots.push({
        flightNumber: flight.flightNumber,
        startMin: t,
        endMin: t + gateOccupancy,
      });

      state.groundCrewUsage.push({
        flightNumber: flight.flightNumber,
        startMin: t,
        endMin: t + duration,
      });

      return { success: true, reason: '' };
    }
  }

  return {
    success: false,
    reason: 'No available slot within the scheduling horizon',
  };
}

function isRunwayAvailable(
  runway: RunwayState,
  startMin: number,
  duration: number,
  opType: OperationType,
  config: Config
): boolean {
  const endMin = startMin + duration;

  for (const slot of runway.slots) {
    // Direct overlap
    if (startMin < slot.endMin && endMin > slot.startMin) return false;

    // New slot follows existing slot — check forward separation
    if (slot.endMin <= startMin) {
      const sep = getRunwaySeparation(slot.operationType, opType, config);
      if (startMin < slot.endMin + sep) return false;
    }

    // New slot precedes existing slot — check backward separation
    if (slot.startMin >= endMin) {
      const sep = getRunwaySeparation(opType, slot.operationType, config);
      if (slot.startMin < endMin + sep) return false;
    }
  }

  return true;
}

function getRunwaySeparation(
  before: OperationType,
  after: OperationType,
  config: Config
): number {
  if (before === 'departure' && after === 'departure')
    return config.runwaySeparationTakeoff;
  if (before === 'arrival' && after === 'arrival')
    return config.runwaySeparationLanding;
  return config.runwaySeparationMixed;
}

function findAvailableGate(
  gates: GateState[],
  startMin: number,
  occupancyDuration: number
): number {
  const endMin = startMin + occupancyDuration;
  for (const gate of gates) {
    const conflict = gate.slots.some(
      (s) => startMin < s.endMin && endMin > s.startMin
    );
    if (!conflict) return gate.index;
  }
  return -1;
}

function isGroundCrewAvailable(
  usage: { startMin: number; endMin: number }[],
  startMin: number,
  duration: number,
  maxCrew: number
): boolean {
  const endMin = startMin + duration;
  const overlapping = usage.filter(
    (u) => u.startMin < endMin && u.endMin > startMin
  );
  return overlapping.length < maxCrew;
}

function removeFlightSlots(flight: Flight, state: AirportState): void {
  if (flight.scheduledRunway !== undefined) {
    const runway = state.runways[flight.scheduledRunway];
    if (runway) {
      runway.slots = runway.slots.filter(
        (s) => s.flightNumber !== flight.flightNumber
      );
    }
  }

  if (flight.scheduledGate !== undefined) {
    const gate = state.gates[flight.scheduledGate];
    if (gate) {
      gate.slots = gate.slots.filter(
        (s) => s.flightNumber !== flight.flightNumber
      );
    }
  }

  state.groundCrewUsage = state.groundCrewUsage.filter(
    (u) => u.flightNumber !== flight.flightNumber
  );
}

function topologicalSort(
  flights: Flight[],
  flightMap: Map<string, Flight>
): Flight[] {
  const flightSet = new Set(flights.map((f) => f.flightNumber));
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>(); // dep -> dependents

  for (const f of flights) {
    if (!inDegree.has(f.flightNumber)) inDegree.set(f.flightNumber, 0);
    if (!adjList.has(f.flightNumber)) adjList.set(f.flightNumber, []);

    for (const dep of f.dependencies) {
      if (!flightSet.has(dep)) continue; // dep not in our set
      const depFlight = flightMap.get(dep);
      if (!depFlight || depFlight.status !== 'scheduled') continue;

      if (!adjList.has(dep)) adjList.set(dep, []);
      adjList.get(dep)!.push(f.flightNumber);
      inDegree.set(f.flightNumber, (inDegree.get(f.flightNumber) ?? 0) + 1);
    }
  }

  // Process nodes with zero in-degree first (sorted by submission for determinism)
  const queue = flights
    .filter((f) => (inDegree.get(f.flightNumber) ?? 0) === 0)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

  const result: Flight[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    for (const neighborId of adjList.get(current.flightNumber) ?? []) {
      const newDegree = (inDegree.get(neighborId) ?? 1) - 1;
      inDegree.set(neighborId, newDegree);
      if (newDegree === 0) {
        const neighbor = flightMap.get(neighborId);
        if (neighbor) queue.push(neighbor);
      }
    }
  }

  // Append any remaining (circular deps) at the end — they won't be in the bottleneck
  for (const f of flights) {
    if (!result.includes(f)) result.push(f);
  }

  return result;
}
