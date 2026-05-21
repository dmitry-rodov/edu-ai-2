export type OperationType = 'arrival' | 'departure';
export type Priority = 'high' | 'medium' | 'low';
export type FlightStatus = 'unscheduled' | 'scheduled' | 'cancelled';

export interface Flight {
  flightNumber: string;
  operationType: OperationType;
  priority: Priority;
  status: FlightStatus;
  dependencies: string[];
  runwayRequirement?: number; // minimum runway length in meters
  submittedAt: string; // ISO timestamp

  // Populated after scheduling (minutes from schedule epoch)
  scheduledStartMin?: number;
  scheduledEndMin?: number;
  scheduledRunway?: number; // 0-indexed
  scheduledGate?: number; // 0-indexed
  unscheduledReason?: string;
}

export interface RunwaySlot {
  flightNumber: string;
  operationType: OperationType;
  startMin: number;
  endMin: number;
}

export interface RunwayState {
  index: number;
  length: number; // meters
  slots: RunwaySlot[];
}

export interface GateSlot {
  flightNumber: string;
  startMin: number;
  endMin: number; // includes turnaround time
}

export interface GateState {
  index: number;
  slots: GateSlot[];
}

export interface GroundCrewUsage {
  flightNumber: string;
  startMin: number;
  endMin: number;
}

export interface AirportState {
  flights: Map<string, Flight>;
  runways: RunwayState[];
  gates: GateState[];
  groundCrewUsage: GroundCrewUsage[];
  scheduleEpoch?: string; // ISO timestamp when last schedule was generated
}
