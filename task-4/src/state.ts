import { type AirportState, type RunwayState, type GateState } from './types.js';
import { type Config } from './config.js';

let airportState: AirportState | null = null;

export function initState(config: Config): void {
  const runways: RunwayState[] = [];
  for (let i = 0; i < config.runwayCount; i++) {
    runways.push({
      index: i,
      length: config.runwayLengths?.[i] ?? 3000,
      slots: [],
    });
  }

  const gates: GateState[] = [];
  for (let i = 0; i < config.gateCount; i++) {
    gates.push({ index: i, slots: [] });
  }

  airportState = {
    flights: new Map(),
    runways,
    gates,
    groundCrewUsage: [],
    scheduleEpoch: undefined,
  };
}

export function getState(): AirportState {
  if (!airportState) throw new Error('Airport state not initialized');
  return airportState;
}

export function resetState(config: Config): void {
  initState(config);
}
