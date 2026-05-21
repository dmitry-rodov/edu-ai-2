import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { loadConfig } from './config.js';
import { initState, getState } from './state.js';
import {
  generateSchedule,
  cancelFlight,
  analyzeBottleneck,
} from './scheduler.js';
import type { OperationType, Priority } from './types.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    process.stderr.write(`[ATC] Configuration error: ${(err as Error).message}\n`);
    process.exit(1);
  }
})();

initState(config);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'airport-atc', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const SubmitFlightSchema = z.object({
  flightNumber: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z0-9-]+$/, 'Flight number must be uppercase alphanumeric'),
  operationType: z.enum(['arrival', 'departure']),
  priority: z.enum(['high', 'medium', 'low']),
  dependencies: z.array(z.string()).optional().default([]),
  runwayRequirement: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Minimum runway length in meters'),
});

const CancelFlightSchema = z.object({
  flightNumber: z.string().min(1),
});

// ---------------------------------------------------------------------------
// List tools
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'submit_flight',
      description:
        'Submit a new arrival or departure to the airport queue. Returns an error if the flight number already exists.',
      inputSchema: {
        type: 'object',
        properties: {
          flightNumber: {
            type: 'string',
            description: 'Unique flight identifier, uppercase alphanumeric (e.g. AA123)',
          },
          operationType: {
            type: 'string',
            enum: ['arrival', 'departure'],
            description: 'Whether this is an inbound arrival or outbound departure',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Scheduling priority — high-priority flights are scheduled earlier',
          },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
            description:
              'List of flight numbers that must complete before this flight can be scheduled',
          },
          runwayRequirement: {
            type: 'number',
            description: 'Minimum runway length in meters required by this flight',
          },
        },
        required: ['flightNumber', 'operationType', 'priority'],
      },
    },
    {
      name: 'generate_schedule',
      description:
        'Compute a fresh schedule from the current flight queue and airport configuration. Replaces any previously generated schedule. Returns summary counts and details of unschedulable flights.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_airport_status',
      description:
        'Return a structured operational snapshot: flight counts by state and type, runway/gate capacity and usage, resource constraints, unscheduled flight reasons, and schedule completion time.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cancel_flight',
      description:
        'Cancel a flight by flight number. Removes it from the current schedule, cascades to all directly and transitively dependent flights, and automatically re-generates the schedule so affected flights are re-evaluated immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          flightNumber: {
            type: 'string',
            description: 'Flight number to cancel',
          },
        },
        required: ['flightNumber'],
      },
    },
    {
      name: 'analyze_bottleneck',
      description:
        'Identify the longest active scheduled dependency chain. Returns the ordered list of flights in the chain and the total elapsed duration from the first flight start to the last flight end.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Call tools
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'submit_flight': {
        const parsed = SubmitFlightSchema.safeParse(args);
        if (!parsed.success) {
          const msg = parsed.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; ');
          return textResult(`Validation error: ${msg}`);
        }

        const state = getState();
        const { flightNumber, operationType, priority, dependencies, runwayRequirement } =
          parsed.data;

        if (state.flights.has(flightNumber)) {
          return textResult(
            `Error: Flight ${flightNumber} already exists (status: ${state.flights.get(flightNumber)!.status})`
          );
        }

        // Validate that referenced dependencies exist (warn but allow)
        const unknownDeps = dependencies.filter((d) => !state.flights.has(d));

        state.flights.set(flightNumber, {
          flightNumber,
          operationType: operationType as OperationType,
          priority: priority as Priority,
          status: 'unscheduled',
          dependencies,
          runwayRequirement,
          submittedAt: new Date().toISOString(),
        });

        const warnings =
          unknownDeps.length > 0
            ? ` Warning: unknown dependency flight(s): ${unknownDeps.join(', ')}`
            : '';

        return textResult(
          JSON.stringify({
            success: true,
            message: `Flight ${flightNumber} (${operationType}, priority=${priority}) added to queue.${warnings}`,
            flightNumber,
            operationType,
            priority,
            dependencies,
            runwayRequirement,
          }, null, 2)
        );
      }

      case 'generate_schedule': {
        const result = generateSchedule(config);
        return textResult(JSON.stringify(result, null, 2));
      }

      case 'get_airport_status': {
        const state = getState();
        const flights = [...state.flights.values()];

        const counts = {
          total: flights.length,
          scheduled: flights.filter((f) => f.status === 'scheduled').length,
          unscheduled: flights.filter((f) => f.status === 'unscheduled').length,
          cancelled: flights.filter((f) => f.status === 'cancelled').length,
          arrivals: {
            total: flights.filter((f) => f.operationType === 'arrival').length,
            scheduled: flights.filter(
              (f) => f.operationType === 'arrival' && f.status === 'scheduled'
            ).length,
          },
          departures: {
            total: flights.filter((f) => f.operationType === 'departure').length,
            scheduled: flights.filter(
              (f) => f.operationType === 'departure' && f.status === 'scheduled'
            ).length,
          },
        };

        const scheduledFlights = flights.filter((f) => f.status === 'scheduled');
        const scheduleCompletionMin =
          scheduledFlights.length > 0
            ? Math.max(...scheduledFlights.map((f) => f.scheduledEndMin ?? 0))
            : null;

        const scheduleCompletionTime =
          scheduleCompletionMin !== null && state.scheduleEpoch
            ? new Date(
                new Date(state.scheduleEpoch).getTime() +
                  scheduleCompletionMin * 60_000
              ).toISOString()
            : null;

        // Runway usage
        const runwayStatus = state.runways.map((r) => {
          const busySlots = r.slots.length;
          return {
            runwayIndex: r.index + 1,
            lengthMeters: r.length,
            scheduledOperations: busySlots,
          };
        });

        // Gate usage — count unique flights currently assigned
        const gateStatus = state.gates.map((g) => {
          return {
            gateIndex: g.index + 1,
            scheduledOperations: g.slots.length,
          };
        });

        const totalGateOps = state.gates.reduce((sum, g) => sum + g.slots.length, 0);
        const gateUtilization = config.gateCount > 0
          ? Math.round((totalGateOps / config.gateCount) * 100) / 100
          : 0;

        // Ground crew — peak concurrent usage
        const peakCrewUsage = computePeakConcurrentUsage(state.groundCrewUsage);

        const unscheduledDetails = flights
          .filter((f) => f.status === 'unscheduled')
          .map((f) => ({
            flightNumber: f.flightNumber,
            operationType: f.operationType,
            priority: f.priority,
            reason: f.unscheduledReason ?? 'Not yet scheduled (run generate_schedule)',
          }));

        const resourceConstraints: string[] = [];
        if (peakCrewUsage >= config.groundCrewCount) {
          resourceConstraints.push(
            `Ground crew fully utilised at peak (${peakCrewUsage}/${config.groundCrewCount})`
          );
        }

        const status = {
          scheduleEpoch: state.scheduleEpoch ?? null,
          scheduleCompletionTime,
          flightCounts: counts,
          runways: {
            total: config.runwayCount,
            details: runwayStatus,
          },
          gates: {
            total: config.gateCount,
            utilizationRatio: gateUtilization,
            details: gateStatus,
          },
          groundCrew: {
            total: config.groundCrewCount,
            peakConcurrentUsage: peakCrewUsage,
          },
          resourceConstraints,
          unscheduledFlights: unscheduledDetails,
        };

        return textResult(JSON.stringify(status, null, 2));
      }

      case 'cancel_flight': {
        const parsed = CancelFlightSchema.safeParse(args);
        if (!parsed.success) {
          return textResult(`Validation error: ${parsed.error.message}`);
        }
        const result = cancelFlight(parsed.data.flightNumber, config);
        return textResult(JSON.stringify(result, null, 2));
      }

      case 'analyze_bottleneck': {
        const result = analyzeBottleneck();
        if (!result) {
          return textResult(
            JSON.stringify(
              {
                message:
                  'No dependency chains found among scheduled flights. Run generate_schedule first or submit flights with dependencies.',
              },
              null,
              2
            )
          );
        }

        const state = getState();
        const epoch = state.scheduleEpoch;

        const chainWithTimestamps = result.chainDetails.map((d) => ({
          flightNumber: d.flightNumber,
          operationType: d.operationType,
          scheduledStartMin: d.startMin,
          scheduledEndMin: d.endMin,
          scheduledStartTime:
            epoch
              ? new Date(
                  new Date(epoch).getTime() + d.startMin * 60_000
                ).toISOString()
              : null,
          scheduledEndTime:
            epoch
              ? new Date(
                  new Date(epoch).getTime() + d.endMin * 60_000
                ).toISOString()
              : null,
        }));

        return textResult(
          JSON.stringify(
            {
              longestDependencyChain: result.chain,
              totalDurationMinutes: result.totalDurationMinutes,
              chain: chainWithTimestamps,
            },
            null,
            2
          )
        );
      }

      default:
        return textResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return textResult(`Internal error: ${(err as Error).message}`);
  }
});

// ---------------------------------------------------------------------------
// List resources
// ---------------------------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'airport://flight-queue',
      name: 'Flight Queue',
      description:
        'All flights in the system including their current status (unscheduled, scheduled, cancelled), priorities, dependencies, runway requirements, and scheduled times if available.',
      mimeType: 'application/json',
    },
    {
      uri: 'airport://runway-availability',
      name: 'Runway Availability',
      description:
        'Per-runway configuration (index, length) and all scheduled operations on each runway with their time windows.',
      mimeType: 'application/json',
    },
    {
      uri: 'airport://operations-timeline',
      name: 'Operations Timeline',
      description:
        'Chronological list of all scheduled airport operations with absolute timestamps, derived from the current schedule.',
      mimeType: 'application/json',
    },
  ],
}));

// ---------------------------------------------------------------------------
// Read resources
// ---------------------------------------------------------------------------

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const state = getState();

  switch (uri) {
    case 'airport://flight-queue': {
      const flights = [...state.flights.values()].map((f) => ({
        flightNumber: f.flightNumber,
        operationType: f.operationType,
        priority: f.priority,
        status: f.status,
        dependencies: f.dependencies,
        runwayRequirement: f.runwayRequirement ?? null,
        submittedAt: f.submittedAt,
        scheduledStartMin: f.scheduledStartMin ?? null,
        scheduledEndMin: f.scheduledEndMin ?? null,
        scheduledStartTime: toAbsoluteTime(state.scheduleEpoch, f.scheduledStartMin),
        scheduledEndTime: toAbsoluteTime(state.scheduleEpoch, f.scheduledEndMin),
        scheduledRunway: f.scheduledRunway !== undefined ? f.scheduledRunway + 1 : null,
        scheduledGate: f.scheduledGate !== undefined ? f.scheduledGate + 1 : null,
        unscheduledReason: f.unscheduledReason ?? null,
      }));

      const summary = {
        total: flights.length,
        scheduled: flights.filter((f) => f.status === 'scheduled').length,
        unscheduled: flights.filter((f) => f.status === 'unscheduled').length,
        cancelled: flights.filter((f) => f.status === 'cancelled').length,
      };

      return jsonResource(uri, { summary, flights });
    }

    case 'airport://runway-availability': {
      const runways = state.runways.map((r) => ({
        runwayIndex: r.index + 1,
        lengthMeters: r.length,
        scheduledOperations: r.slots.map((s) => ({
          flightNumber: s.flightNumber,
          operationType: s.operationType,
          startMin: s.startMin,
          endMin: s.endMin,
          startTime: toAbsoluteTime(state.scheduleEpoch, s.startMin),
          endTime: toAbsoluteTime(state.scheduleEpoch, s.endMin),
        })),
        totalOccupiedMinutes: r.slots.reduce(
          (sum, s) => sum + (s.endMin - s.startMin),
          0
        ),
      }));

      return jsonResource(uri, {
        scheduleEpoch: state.scheduleEpoch ?? null,
        runways,
        separationBuffers: {
          takeoffAfterTakeoff: config.runwaySeparationTakeoff,
          landingAfterLanding: config.runwaySeparationLanding,
          mixed: config.runwaySeparationMixed,
        },
      });
    }

    case 'airport://operations-timeline': {
      // Collect all scheduled operations and sort chronologically
      const ops: Array<{
        flightNumber: string;
        operationType: string;
        priority: string;
        startMin: number;
        endMin: number;
        startTime: string | null;
        endTime: string | null;
        runway: number;
        gate: number | null;
        dependencies: string[];
      }> = [];

      for (const f of state.flights.values()) {
        if (f.status !== 'scheduled') continue;
        ops.push({
          flightNumber: f.flightNumber,
          operationType: f.operationType,
          priority: f.priority,
          startMin: f.scheduledStartMin ?? 0,
          endMin: f.scheduledEndMin ?? 0,
          startTime: toAbsoluteTime(state.scheduleEpoch, f.scheduledStartMin),
          endTime: toAbsoluteTime(state.scheduleEpoch, f.scheduledEndMin),
          runway: (f.scheduledRunway ?? 0) + 1,
          gate: f.scheduledGate !== undefined ? f.scheduledGate + 1 : null,
          dependencies: f.dependencies,
        });
      }

      ops.sort((a, b) => a.startMin - b.startMin || a.flightNumber.localeCompare(b.flightNumber));

      return jsonResource(uri, {
        scheduleEpoch: state.scheduleEpoch ?? null,
        totalOperations: ops.length,
        timeline: ops,
      });
    }

    default:
      throw new Error(`Unknown resource URI: ${uri}`);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResource(uri: string, data: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function toAbsoluteTime(
  epochIso: string | undefined,
  minutes: number | undefined
): string | null {
  if (epochIso === undefined || minutes === undefined) return null;
  return new Date(new Date(epochIso).getTime() + minutes * 60_000).toISOString();
}

function computePeakConcurrentUsage(
  usage: { startMin: number; endMin: number }[]
): number {
  if (usage.length === 0) return 0;

  // Sweep-line: find maximum concurrent overlapping intervals
  const events: Array<{ time: number; delta: number }> = [];
  for (const u of usage) {
    events.push({ time: u.startMin, delta: 1 });
    events.push({ time: u.endMin, delta: -1 });
  }
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let current = 0;
  let peak = 0;
  for (const e of events) {
    current += e.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[ATC] Airport ATC MCP server started\n');
