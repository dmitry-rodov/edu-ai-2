import { z } from 'zod';

const configSchema = z.object({
  runwayCount: z.number().int().min(1, 'RUNWAY_COUNT must be at least 1'),
  gateCount: z.number().int().min(1, 'GATE_COUNT must be at least 1'),
  groundCrewCount: z.number().int().min(1, 'GROUND_CREW_COUNT must be at least 1'),
  runwaySeparationTakeoff: z.number().int().min(0, 'RUNWAY_SEPARATION_TAKEOFF must be >= 0'),
  runwaySeparationLanding: z.number().int().min(0, 'RUNWAY_SEPARATION_LANDING must be >= 0'),
  runwaySeparationMixed: z.number().int().min(0, 'RUNWAY_SEPARATION_MIXED must be >= 0'),
  gateTurnaroundTime: z.number().int().min(0, 'GATE_TURNAROUND_TIME must be >= 0'),
  dependencyBuffer: z.number().int().min(0, 'DEPENDENCY_BUFFER_TIME must be >= 0'),
  maxSchedulingHorizon: z.number().int().min(1, 'MAX_SCHEDULING_HORIZON must be at least 1'),
  runwayLengths: z.array(z.number().int().min(1)).optional(),
  arrivalDuration: z.number().int().min(1, 'ARRIVAL_DURATION must be at least 1'),
  departureDuration: z.number().int().min(1, 'DEPARTURE_DURATION must be at least 1'),
});

export type Config = z.infer<typeof configSchema>;

function parseEnvInt(name: string, defaultValue?: number): number {
  const val = process.env[name];
  if (val === undefined || val.trim() === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  const num = parseInt(val.trim(), 10);
  if (isNaN(num)) throw new Error(`Invalid integer for ${name}: "${val}"`);
  return num;
}

export function loadConfig(): Config {
  const runwayCount = parseEnvInt('RUNWAY_COUNT');

  let runwayLengths: number[] | undefined;
  const rl = process.env['RUNWAY_LENGTHS'];
  if (rl && rl.trim() !== '') {
    const parsed = rl.split(',').map((s: string, i: number) => {
      const n = parseInt(s.trim(), 10);
      if (isNaN(n) || n < 1) throw new Error(`Invalid runway length at index ${i}: "${s.trim()}"`);
      return n;
    });
    if (parsed.length !== runwayCount) {
      throw new Error(
        `RUNWAY_LENGTHS must have exactly ${runwayCount} value(s) to match RUNWAY_COUNT, got ${parsed.length}`
      );
    }
    runwayLengths = parsed;
  }

  const raw = {
    runwayCount,
    gateCount: parseEnvInt('GATE_COUNT'),
    groundCrewCount: parseEnvInt('GROUND_CREW_COUNT'),
    runwaySeparationTakeoff: parseEnvInt('RUNWAY_SEPARATION_TAKEOFF'),
    runwaySeparationLanding: parseEnvInt('RUNWAY_SEPARATION_LANDING'),
    runwaySeparationMixed: parseEnvInt('RUNWAY_SEPARATION_MIXED'),
    gateTurnaroundTime: parseEnvInt('GATE_TURNAROUND_TIME'),
    dependencyBuffer: parseEnvInt('DEPENDENCY_BUFFER_TIME'),
    maxSchedulingHorizon: parseEnvInt('MAX_SCHEDULING_HORIZON'),
    runwayLengths,
    arrivalDuration: parseEnvInt('ARRIVAL_DURATION', 15),
    departureDuration: parseEnvInt('DEPARTURE_DURATION', 20),
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`Invalid configuration: ${messages}`);
  }

  return result.data;
}
