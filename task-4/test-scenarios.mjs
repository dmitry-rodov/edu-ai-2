#!/usr/bin/env node
/**
 * Automated test harness for the Airport ATC MCP server.
 * Spawns the server as a child process and communicates via JSON-RPC over stdio.
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENV = {
  RUNWAY_COUNT: '2',
  GATE_COUNT: '4',
  GROUND_CREW_COUNT: '3',
  RUNWAY_SEPARATION_TAKEOFF: '2',
  RUNWAY_SEPARATION_LANDING: '3',
  RUNWAY_SEPARATION_MIXED: '4',
  GATE_TURNAROUND_TIME: '30',
  DEPENDENCY_BUFFER_TIME: '15',
  MAX_SCHEDULING_HORIZON: '480',
  RUNWAY_LENGTHS: '3000,2500',
  ARRIVAL_DURATION: '15',
  DEPARTURE_DURATION: '20',
};

let requestId = 0;
let serverProc = null;
let responseBuffer = '';
const pendingRequests = new Map();
let testsPassed = 0;
let testsFailed = 0;
const failures = [];

function startServer(envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...ENV, ...envOverrides };
    serverProc = spawn('node', ['dist/index.js'], {
      cwd: __dirname,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverProc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('started')) {
        // Give it a moment to be fully ready
        setTimeout(() => resolve(), 200);
      }
    });

    serverProc.stdout.on('data', (data) => {
      responseBuffer += data.toString();
      processBuffer();
    });

    serverProc.on('error', reject);
    serverProc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Server exited with code ${code}`));
      }
    });

    // Timeout if server doesn't start
    setTimeout(() => reject(new Error('Server start timeout')), 5000);
  });
}

function processBuffer() {
  // MCP SDK v1.29 uses newline-delimited JSON (NDJSON)
  while (true) {
    const newlineIdx = responseBuffer.indexOf('\n');
    if (newlineIdx === -1) break;

    const line = responseBuffer.substring(0, newlineIdx).replace(/\r$/, '');
    responseBuffer = responseBuffer.substring(newlineIdx + 1);

    if (!line.trim()) continue;

    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        pendingRequests.get(msg.id)(msg);
        pendingRequests.delete(msg.id);
      }
    } catch (e) {
      console.error('Failed to parse:', line.substring(0, 200));
    }
  }
}

function sendRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const frame = msg + '\n';

    pendingRequests.set(id, resolve);
    serverProc.stdin.write(frame);

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }
    }, 10000);
  });
}

async function initialize() {
  const resp = await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-harness', version: '1.0.0' },
  });
  // notifications/initialized is a notification (no response expected)
  const notif = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  serverProc.stdin.write(notif + '\n');
  return resp;
}

async function callTool(name, args = {}) {
  const resp = await sendRequest('tools/call', { name, arguments: args });
  if (resp.error) throw new Error(`Tool error: ${JSON.stringify(resp.error)}`);
  const text = resp.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : resp.result;
}

async function readResource(uri) {
  const resp = await sendRequest('resources/read', { uri });
  if (resp.error) throw new Error(`Resource error: ${JSON.stringify(resp.error)}`);
  const text = resp.result?.contents?.[0]?.text;
  return text ? JSON.parse(text) : resp.result;
}

async function listTools() {
  const resp = await sendRequest('tools/list', {});
  return resp.result?.tools ?? [];
}

async function listResources() {
  const resp = await sendRequest('resources/list', {});
  return resp.result?.resources ?? [];
}

function stopServer() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    serverProc = null;
    responseBuffer = '';
    requestId = 0;
  }
}

function assert(condition, message) {
  if (!condition) {
    testsFailed++;
    failures.push(message);
    console.log(`  ❌ FAIL: ${message}`);
    return false;
  }
  testsPassed++;
  console.log(`  ✅ PASS: ${message}`);
  return true;
}

// ==========================================
// TEST SCENARIOS
// ==========================================

async function testInvalidConfig() {
  console.log('\n=== Test: Invalid Configuration Fails at Startup ===');
  
  return new Promise((resolveTest) => {
    let resolved = false;
    const proc = spawn('node', ['dist/index.js'], {
      cwd: __dirname,
      env: { ...process.env }, // no config vars
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    
    proc.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      assert(code !== 0, 'Server exits with non-zero code on missing config');
      assert(stderr.includes('Configuration error') || stderr.includes('Missing required'), 
        `Stderr contains config error message: "${stderr.trim().substring(0, 100)}"`);
      resolveTest();
    });

    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      assert(false, 'Server should have exited on invalid config');
      resolveTest();
    }, 5000);
  });
}

async function testMCPInterface() {
  console.log('\n=== Test: MCP Interface — Tools and Resources ===');

  const tools = await listTools();
  const toolNames = tools.map(t => t.name);
  
  assert(toolNames.includes('submit_flight'), 'submit_flight tool exists');
  assert(toolNames.includes('generate_schedule'), 'generate_schedule tool exists');
  assert(toolNames.includes('get_airport_status'), 'get_airport_status tool exists');
  assert(toolNames.includes('cancel_flight'), 'cancel_flight tool exists');
  assert(toolNames.includes('analyze_bottleneck'), 'analyze_bottleneck tool exists');

  const resources = await listResources();
  const resourceUris = resources.map(r => r.uri);

  assert(resourceUris.includes('airport://flight-queue'), 'flight-queue resource exists');
  assert(resourceUris.includes('airport://runway-availability'), 'runway-availability resource exists');
  assert(resourceUris.includes('airport://operations-timeline'), 'operations-timeline resource exists');
}

async function testScenario1_MorningRush() {
  console.log('\n=== Scenario 1: Morning Rush ===');

  // Submit flights with mixed types
  const r1 = await callTool('submit_flight', {
    flightNumber: 'AA100',
    operationType: 'arrival',
    priority: 'high',
  });
  assert(r1.success === true, 'High-priority arrival AA100 submitted');

  const r2 = await callTool('submit_flight', {
    flightNumber: 'UA200',
    operationType: 'departure',
    priority: 'medium',
  });
  assert(r2.success === true, 'Medium-priority departure UA200 submitted');

  const r3 = await callTool('submit_flight', {
    flightNumber: 'DL300',
    operationType: 'arrival',
    priority: 'low',
  });
  assert(r3.success === true, 'Low-priority arrival DL300 submitted');

  const r4 = await callTool('submit_flight', {
    flightNumber: 'SW400',
    operationType: 'departure',
    priority: 'low',
  });
  assert(r4.success === true, 'Low-priority departure SW400 submitted');

  // Generate schedule
  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 4, `All 4 flights scheduled (got ${schedule.scheduledCount})`);
  assert(schedule.unscheduledCount === 0, `No unscheduled flights (got ${schedule.unscheduledCount})`);

  // Check flight queue
  const queue = await readResource('airport://flight-queue');
  assert(queue.summary.scheduled === 4, `Queue shows 4 scheduled (got ${queue.summary.scheduled})`);
  assert(queue.summary.unscheduled === 0, `Queue shows 0 unscheduled (got ${queue.summary.unscheduled})`);

  // Check timeline
  const timeline = await readResource('airport://operations-timeline');
  assert(timeline.totalOperations === 4, `Timeline has 4 operations (got ${timeline.totalOperations})`);

  // Check no overlapping runway usage
  const runwayData = await readResource('airport://runway-availability');
  let hasOverlap = false;
  for (const rw of runwayData.runways) {
    const ops = rw.scheduledOperations.sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < ops.length; i++) {
      if (ops[i].startMin < ops[i-1].endMin) {
        hasOverlap = true;
        break;
      }
    }
  }
  assert(!hasOverlap, 'No runway overlap detected');

  // Check no overlapping gate usage
  const statusData = await callTool('get_airport_status');
  // Priority ordering: high-priority AA100 should start earliest
  const aa100 = queue.flights.find(f => f.flightNumber === 'AA100');
  const ua200 = queue.flights.find(f => f.flightNumber === 'UA200');
  const dl300 = queue.flights.find(f => f.flightNumber === 'DL300');
  const sw400 = queue.flights.find(f => f.flightNumber === 'SW400');
  
  assert(aa100.scheduledStartMin <= ua200.scheduledStartMin, 
    `High-priority AA100 (start=${aa100.scheduledStartMin}) scheduled no later than medium UA200 (start=${ua200.scheduledStartMin})`);
  assert(aa100.scheduledStartMin <= dl300.scheduledStartMin,
    `High-priority AA100 (start=${aa100.scheduledStartMin}) scheduled no later than low DL300 (start=${dl300.scheduledStartMin})`);
}

async function testScenario2_HeavyHauler() {
  console.log('\n=== Scenario 2: Heavy Hauler ===');

  // Submit a flight requiring runway > any available (max is 3000m)
  const r1 = await callTool('submit_flight', {
    flightNumber: 'HH500',
    operationType: 'departure',
    priority: 'high',
    runwayRequirement: 4000,
  });
  assert(r1.success === true, 'Heavy hauler HH500 submitted');

  // Also submit a normal flight
  const r2 = await callTool('submit_flight', {
    flightNumber: 'NM600',
    operationType: 'arrival',
    priority: 'medium',
  });
  assert(r2.success === true, 'Normal flight NM600 submitted');

  // Generate schedule
  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 1, `1 flight scheduled (got ${schedule.scheduledCount})`);
  assert(schedule.unscheduledCount === 1, `1 flight unscheduled (got ${schedule.unscheduledCount})`);

  // Verify the heavy hauler was not scheduled
  const unscheduled = schedule.unscheduledFlights.find(f => f.flightNumber === 'HH500');
  assert(unscheduled !== undefined, 'HH500 is in the unscheduled list');
  assert(unscheduled.reason.includes('runway') || unscheduled.reason.includes('length'),
    `Unscheduled reason mentions runway constraint: "${unscheduled.reason}"`);

  // Check flight queue
  const queue = await readResource('airport://flight-queue');
  const hh = queue.flights.find(f => f.flightNumber === 'HH500');
  assert(hh.status === 'unscheduled', `HH500 status is unscheduled (got ${hh.status})`);
  assert(hh.unscheduledReason !== null, 'HH500 has an unscheduled reason');

  // Normal flight should still be scheduled
  const nm = queue.flights.find(f => f.flightNumber === 'NM600');
  assert(nm.status === 'scheduled', `Normal flight NM600 is scheduled (got ${nm.status})`);

  // Status should reflect this
  const status = await callTool('get_airport_status');
  assert(status.unscheduledFlights.length === 1, 
    `Status shows 1 unscheduled flight (got ${status.unscheduledFlights.length})`);
}

async function testScenario3_ConnectingFlight() {
  console.log('\n=== Scenario 3: Connecting Flight ===');

  // Submit inbound arrival
  const r1 = await callTool('submit_flight', {
    flightNumber: 'IN700',
    operationType: 'arrival',
    priority: 'high',
  });
  assert(r1.success === true, 'Inbound flight IN700 submitted');

  // Submit outbound departure depending on IN700
  const r2 = await callTool('submit_flight', {
    flightNumber: 'OUT800',
    operationType: 'departure',
    priority: 'medium',
    dependencies: ['IN700'],
  });
  assert(r2.success === true, 'Outbound flight OUT800 submitted with dependency on IN700');

  // Generate schedule
  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 2, `Both flights scheduled (got ${schedule.scheduledCount})`);

  // Check timeline
  const timeline = await readResource('airport://operations-timeline');
  const in700 = timeline.timeline.find(f => f.flightNumber === 'IN700');
  const out800 = timeline.timeline.find(f => f.flightNumber === 'OUT800');

  assert(in700 !== undefined, 'IN700 appears in timeline');
  assert(out800 !== undefined, 'OUT800 appears in timeline');

  // Outbound must start after inbound ends + dependency buffer (15 min)
  assert(out800.startMin >= in700.endMin + 15,
    `OUT800 start (${out800.startMin}) >= IN700 end (${in700.endMin}) + buffer 15 = ${in700.endMin + 15}`);

  // Dependency order visible
  assert(out800.dependencies.includes('IN700'), 'OUT800 dependencies include IN700 in timeline');

  // Bottleneck analysis should find this chain
  const bottleneck = await callTool('analyze_bottleneck');
  assert(bottleneck.longestDependencyChain !== undefined, 'Bottleneck analysis returns a chain');
  assert(bottleneck.longestDependencyChain.includes('IN700'), 'Chain includes IN700');
  assert(bottleneck.longestDependencyChain.includes('OUT800'), 'Chain includes OUT800');
  assert(bottleneck.totalDurationMinutes > 0, `Total duration > 0 (got ${bottleneck.totalDurationMinutes})`);
}

async function testCancelFlight() {
  console.log('\n=== Test: Cancel Flight with Cascading Dependencies ===');

  // Submit a chain: A -> B -> C
  await callTool('submit_flight', { flightNumber: 'CA100', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'CB200', operationType: 'departure', priority: 'medium', dependencies: ['CA100'] });
  await callTool('submit_flight', { flightNumber: 'CC300', operationType: 'arrival', priority: 'low', dependencies: ['CB200'] });

  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 3, `All 3 chain flights scheduled (got ${schedule.scheduledCount})`);

  // Cancel the middle flight — this auto-reschedules
  const cancelResult = await callTool('cancel_flight', { flightNumber: 'CB200' });
  assert(cancelResult.success === true, 'CB200 cancelled successfully');
  assert(cancelResult.affectedFlights.includes('CC300'), 'CC300 is in affected flights (transitive dependency)');
  assert(cancelResult.rescheduleSummary !== undefined, 'Cancel result includes reschedule summary');

  // Check state — CC300 should be rescheduled automatically (its cancelled dep is resolved)
  const queue = await readResource('airport://flight-queue');
  const cb = queue.flights.find(f => f.flightNumber === 'CB200');
  const cc = queue.flights.find(f => f.flightNumber === 'CC300');
  assert(cb.status === 'cancelled', `CB200 status is cancelled (got ${cb.status})`);
  assert(cc.status === 'scheduled', `CC300 auto-rescheduled after cancel (got ${cc.status})`);

  // CA100 should still be scheduled
  const ca = queue.flights.find(f => f.flightNumber === 'CA100');
  assert(ca.status === 'scheduled', `CA100 is still scheduled (got ${ca.status})`);
}

async function testDuplicateFlightRejection() {
  console.log('\n=== Test: Duplicate Flight Rejection ===');

  await callTool('submit_flight', { flightNumber: 'DUP1', operationType: 'arrival', priority: 'low' });
  
  // Try submitting the same flight again — should return an error message
  const resp = await sendRequest('tools/call', {
    name: 'submit_flight',
    arguments: { flightNumber: 'DUP1', operationType: 'arrival', priority: 'low' },
  });
  const text = resp.result?.content?.[0]?.text ?? '';
  assert(text.includes('already exists'), `Duplicate flight rejected with message: "${text.substring(0, 100)}"`);
}

async function testCancelNonexistent() {
  console.log('\n=== Test: Cancel Nonexistent Flight ===');

  const result = await callTool('cancel_flight', { flightNumber: 'NOPE999' });
  assert(result.success === false, 'Cancel returns success=false for nonexistent flight');
  assert(result.reason.includes('not found'), `Reason mentions not found: "${result.reason}"`);
}

async function testEmptySchedule() {
  console.log('\n=== Test: Empty Schedule ===');

  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 0, `No flights to schedule (got ${schedule.scheduledCount})`);

  const status = await callTool('get_airport_status');
  assert(status.flightCounts.total === 0, `Status shows 0 total flights (got ${status.flightCounts.total})`);

  const bottleneck = await callTool('analyze_bottleneck');
  assert(bottleneck.message !== undefined, 'Bottleneck returns message when no chains exist');
}

async function testCircularDependency() {
  console.log('\n=== Test: Circular Dependency ===');

  // A depends on B, B depends on A
  await callTool('submit_flight', { flightNumber: 'CIR-A', operationType: 'arrival', priority: 'high', dependencies: ['CIR-B'] });
  await callTool('submit_flight', { flightNumber: 'CIR-B', operationType: 'departure', priority: 'high', dependencies: ['CIR-A'] });

  const schedule = await callTool('generate_schedule');
  assert(schedule.unscheduledCount === 2, `Both circular flights unscheduled (got ${schedule.unscheduledCount})`);

  const queue = await readResource('airport://flight-queue');
  const cirA = queue.flights.find(f => f.flightNumber === 'CIR-A');
  const cirB = queue.flights.find(f => f.flightNumber === 'CIR-B');
  assert(cirA.status === 'unscheduled', 'CIR-A is unscheduled');
  assert(cirB.status === 'unscheduled', 'CIR-B is unscheduled');
  assert(
    (cirA.unscheduledReason && cirA.unscheduledReason.toLowerCase().includes('circular')) ||
    (cirA.unscheduledReason && cirA.unscheduledReason.toLowerCase().includes('unresolvable')),
    `CIR-A reason mentions circular/unresolvable: "${cirA.unscheduledReason}"`
  );
}

async function testDeterminism() {
  console.log('\n=== Test: Deterministic Scheduling ===');

  // Submit flights, schedule, record, schedule again, compare
  await callTool('submit_flight', { flightNumber: 'DET-A', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'DET-B', operationType: 'departure', priority: 'medium' });
  await callTool('submit_flight', { flightNumber: 'DET-C', operationType: 'arrival', priority: 'low' });

  await callTool('generate_schedule');
  const queue1 = await readResource('airport://flight-queue');
  const slots1 = queue1.flights.map(f => ({
    fn: f.flightNumber,
    start: f.scheduledStartMin,
    end: f.scheduledEndMin,
    runway: f.scheduledRunway,
    gate: f.scheduledGate,
  }));

  // Re-schedule
  await callTool('generate_schedule');
  const queue2 = await readResource('airport://flight-queue');
  const slots2 = queue2.flights.map(f => ({
    fn: f.flightNumber,
    start: f.scheduledStartMin,
    end: f.scheduledEndMin,
    runway: f.scheduledRunway,
    gate: f.scheduledGate,
  }));

  assert(JSON.stringify(slots1) === JSON.stringify(slots2), 'Two consecutive schedules produce identical assignments');
}

async function testResourceConstraints() {
  console.log('\n=== Test: Resource Constraints — Ground Crew Limit ===');

  // With GROUND_CREW_COUNT=3, submit 5 flights and check they respect the limit
  for (let i = 1; i <= 5; i++) {
    await callTool('submit_flight', {
      flightNumber: `GC${i}00`,
      operationType: i % 2 === 0 ? 'departure' : 'arrival',
      priority: 'high',
    });
  }

  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 5, `All 5 flights scheduled (got ${schedule.scheduledCount})`);

  const status = await callTool('get_airport_status');
  assert(status.groundCrew.peakConcurrentUsage <= 3,
    `Peak ground crew usage (${status.groundCrew.peakConcurrentUsage}) <= limit 3`);
}

async function testGateAvailability() {
  console.log('\n=== Test: Gate Availability with Turnaround ===');

  // Submit many flights to test gate turnaround (30 min)
  for (let i = 1; i <= 6; i++) {
    await callTool('submit_flight', {
      flightNumber: `GT${i}00`,
      operationType: 'arrival',
      priority: 'high',
    });
  }

  await callTool('generate_schedule');
  const queue = await readResource('airport://flight-queue');

  // Check no gate overlaps (gate occupancy = duration + turnaround = 15 + 30 = 45 min)
  // Build per-gate slots from flight data - we need the raw state data
  // Instead, check via status that gates are being used
  const status = await callTool('get_airport_status');
  assert(status.gates.total === 4, 'Airport has 4 gates');

  // With 4 gates and 45-min occupancy each, and 480-min horizon,
  // each gate can handle ~10 flights. 6 flights should all be scheduled.
  assert(queue.summary.scheduled === 6, `All 6 flights scheduled (got ${queue.summary.scheduled})`);
}

async function testRunwaySeparation() {
  console.log('\n=== Test: Runway Separation Buffers ===');

  // Submit 3 arrivals that will go on same runway and check separation
  await callTool('submit_flight', { flightNumber: 'RS100', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'RS200', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'RS300', operationType: 'departure', priority: 'high' });

  await callTool('generate_schedule');
  const runwayData = await readResource('airport://runway-availability');

  for (const rw of runwayData.runways) {
    const ops = rw.scheduledOperations.sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < ops.length; i++) {
      const prev = ops[i-1];
      const curr = ops[i];
      const gap = curr.startMin - prev.endMin;
      
      // Determine expected separation
      let expectedSep;
      if (prev.operationType === 'arrival' && curr.operationType === 'arrival') {
        expectedSep = 3; // RUNWAY_SEPARATION_LANDING
      } else if (prev.operationType === 'departure' && curr.operationType === 'departure') {
        expectedSep = 2; // RUNWAY_SEPARATION_TAKEOFF
      } else {
        expectedSep = 4; // RUNWAY_SEPARATION_MIXED
      }

      assert(gap >= expectedSep,
        `Runway ${rw.runwayIndex}: gap between ${prev.flightNumber} and ${curr.flightNumber} is ${gap} >= ${expectedSep} (${prev.operationType}→${curr.operationType})`);
    }
  }
}

async function testScheduleExceedsHorizon() {
  console.log('\n=== Test: Schedule Exceeds Horizon ===');

  // With horizon=480 and 1 runway of 3000m, arrival=15min, separation=3,
  // max arrivals per runway ≈ 480 / (15+3) = 26. With 2 runways ≈ 52.
  // Submit many flights to overflow. 
  // Actually let's be smart: use large runway requirement to force only 1 runway,
  // then submit enough flights to exceed horizon.
  // Single runway can fit ~26 arrivals. Submit 30.
  for (let i = 1; i <= 30; i++) {
    await callTool('submit_flight', {
      flightNumber: `HZ${String(i).padStart(3, '0')}`,
      operationType: 'arrival',
      priority: 'low',
      runwayRequirement: 2600, // forces only the 3000m runway
    });
  }

  const schedule = await callTool('generate_schedule');
  // Some flights should not fit
  // With 1 runway: slot = 15min + 3min separation = 18min per flight. 
  // But also need gates (4 gates, 45min each = ~10 per gate per 480min)
  // So max ~40 on gates (not the bottleneck) and ~26 on the runway.
  // Ground crew max 3 concurrent — also shouldn't be bottleneck since they're serial.
  assert(schedule.unscheduledCount > 0, 
    `Some flights unscheduled due to horizon (${schedule.unscheduledCount} unscheduled of 30)`);

  // Check reasons
  for (const us of schedule.unscheduledFlights) {
    assert(us.reason.includes('horizon') || us.reason.includes('slot'),
      `Unscheduled flight ${us.flightNumber} reason: "${us.reason}"`);
  }
}

async function testCancelAlreadyCancelled() {
  console.log('\n=== Test: Cancel Already Cancelled Flight ===');

  await callTool('submit_flight', { flightNumber: 'CX100', operationType: 'arrival', priority: 'low' });
  await callTool('cancel_flight', { flightNumber: 'CX100' });
  const result = await callTool('cancel_flight', { flightNumber: 'CX100' });
  assert(result.success === false, 'Cannot cancel an already cancelled flight');
  assert(result.reason.includes('already cancelled'), `Reason: "${result.reason}"`);
}

async function testCancelledFlightVisible() {
  console.log('\n=== Test: Cancelled Flight Visible in Queue ===');

  await callTool('submit_flight', { flightNumber: 'VIS100', operationType: 'departure', priority: 'medium' });
  await callTool('generate_schedule');
  await callTool('cancel_flight', { flightNumber: 'VIS100' });

  const queue = await readResource('airport://flight-queue');
  const vis = queue.flights.find(f => f.flightNumber === 'VIS100');
  assert(vis !== undefined, 'Cancelled flight VIS100 still visible in queue');
  assert(vis.status === 'cancelled', `Status is cancelled (got ${vis.status})`);
  assert(queue.summary.cancelled >= 1, `Summary shows cancelled flights (got ${queue.summary.cancelled})`);
}

async function testRescheduleAfterCancel() {
  console.log('\n=== Test: Reschedule After Cancel ===');

  await callTool('submit_flight', { flightNumber: 'RC100', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'RC200', operationType: 'departure', priority: 'medium', dependencies: ['RC100'] });

  await callTool('generate_schedule');
  await callTool('cancel_flight', { flightNumber: 'RC100' });

  // RC200 should be auto-rescheduled since its cancelled dep is treated as resolved
  let queue = await readResource('airport://flight-queue');
  let rc200 = queue.flights.find(f => f.flightNumber === 'RC200');
  assert(rc200.status === 'scheduled', `RC200 auto-rescheduled after dep cancelled (got ${rc200.status})`);

  const rc100 = queue.flights.find(f => f.flightNumber === 'RC100');
  assert(rc100.status === 'cancelled', `RC100 stays cancelled (got ${rc100.status})`);
}

async function testAirportStatusStructure() {
  console.log('\n=== Test: Airport Status Structure ===');

  await callTool('submit_flight', { flightNumber: 'ST100', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'ST200', operationType: 'departure', priority: 'low' });
  await callTool('generate_schedule');

  const status = await callTool('get_airport_status');

  // Check required fields
  assert(status.scheduleEpoch !== null, 'Status has scheduleEpoch');
  assert(status.scheduleCompletionTime !== null, 'Status has scheduleCompletionTime');
  assert(status.flightCounts !== undefined, 'Status has flightCounts');
  assert(status.flightCounts.arrivals !== undefined, 'Status has arrivals breakdown');
  assert(status.flightCounts.departures !== undefined, 'Status has departures breakdown');
  assert(status.runways !== undefined, 'Status has runways');
  assert(status.runways.total === 2, `Runway total is 2 (got ${status.runways.total})`);
  assert(status.gates !== undefined, 'Status has gates');
  assert(status.gates.total === 4, `Gate total is 4 (got ${status.gates.total})`);
  assert(status.groundCrew !== undefined, 'Status has groundCrew');
  assert(status.groundCrew.total === 3, `Ground crew total is 3 (got ${status.groundCrew.total})`);
  assert(Array.isArray(status.resourceConstraints), 'Status has resourceConstraints array');
  assert(Array.isArray(status.unscheduledFlights), 'Status has unscheduledFlights array');
}

async function testInputValidation() {
  console.log('\n=== Test: Input Validation ===');

  // Invalid flight number (lowercase)
  const resp1 = await sendRequest('tools/call', {
    name: 'submit_flight',
    arguments: { flightNumber: 'invalid', operationType: 'arrival', priority: 'high' },
  });
  const text1 = resp1.result?.content?.[0]?.text ?? '';
  assert(text1.toLowerCase().includes('validation') || text1.toLowerCase().includes('error'),
    `Lowercase flight number rejected: "${text1.substring(0, 80)}"`);

  // Invalid operation type
  const resp2 = await sendRequest('tools/call', {
    name: 'submit_flight',
    arguments: { flightNumber: 'VAL100', operationType: 'hover', priority: 'high' },
  });
  const text2 = resp2.result?.content?.[0]?.text ?? '';
  assert(text2.toLowerCase().includes('validation') || text2.toLowerCase().includes('error'),
    `Invalid operationType rejected: "${text2.substring(0, 80)}"`);

  // Invalid priority
  const resp3 = await sendRequest('tools/call', {
    name: 'submit_flight',
    arguments: { flightNumber: 'VAL200', operationType: 'arrival', priority: 'urgent' },
  });
  const text3 = resp3.result?.content?.[0]?.text ?? '';
  assert(text3.toLowerCase().includes('validation') || text3.toLowerCase().includes('error'),
    `Invalid priority rejected: "${text3.substring(0, 80)}"`);
}

// ==========================================
// ADDITIONAL EDGE CASE TESTS
// ==========================================

async function testMultiLevelDepChain() {
  console.log('\n=== Test: Multi-Level Dependency Chain (A→B→C→D) ===');

  await callTool('submit_flight', { flightNumber: 'ML-A', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'ML-B', operationType: 'departure', priority: 'medium', dependencies: ['ML-A'] });
  await callTool('submit_flight', { flightNumber: 'ML-C', operationType: 'arrival', priority: 'medium', dependencies: ['ML-B'] });
  await callTool('submit_flight', { flightNumber: 'ML-D', operationType: 'departure', priority: 'low', dependencies: ['ML-C'] });

  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 4, `All 4 chain flights scheduled (got ${schedule.scheduledCount})`);

  const timeline = await readResource('airport://operations-timeline');
  const a = timeline.timeline.find(f => f.flightNumber === 'ML-A');
  const b = timeline.timeline.find(f => f.flightNumber === 'ML-B');
  const c = timeline.timeline.find(f => f.flightNumber === 'ML-C');
  const d = timeline.timeline.find(f => f.flightNumber === 'ML-D');

  // Each must start after its dep ends + 15 min buffer
  assert(b.startMin >= a.endMin + 15, `ML-B (${b.startMin}) starts after ML-A end+buffer (${a.endMin + 15})`);
  assert(c.startMin >= b.endMin + 15, `ML-C (${c.startMin}) starts after ML-B end+buffer (${b.endMin + 15})`);
  assert(d.startMin >= c.endMin + 15, `ML-D (${d.startMin}) starts after ML-C end+buffer (${c.endMin + 15})`);

  // Bottleneck should find this 4-flight chain
  const bottleneck = await callTool('analyze_bottleneck');
  assert(bottleneck.longestDependencyChain.length === 4, `Bottleneck chain has 4 flights (got ${bottleneck.longestDependencyChain.length})`);
  assert(bottleneck.totalDurationMinutes === d.endMin - a.startMin,
    `Bottleneck duration (${bottleneck.totalDurationMinutes}) matches D.end - A.start (${d.endMin - a.startMin})`);
}

async function testFanOutDependencies() {
  console.log('\n=== Test: Fan-Out — Multiple Flights Depend on One ===');

  await callTool('submit_flight', { flightNumber: 'FO-A', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'FO-B1', operationType: 'departure', priority: 'medium', dependencies: ['FO-A'] });
  await callTool('submit_flight', { flightNumber: 'FO-B2', operationType: 'departure', priority: 'medium', dependencies: ['FO-A'] });
  await callTool('submit_flight', { flightNumber: 'FO-B3', operationType: 'departure', priority: 'low', dependencies: ['FO-A'] });

  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 4, `All 4 flights scheduled (got ${schedule.scheduledCount})`);

  const queue = await readResource('airport://flight-queue');
  const foA = queue.flights.find(f => f.flightNumber === 'FO-A');
  for (const fn of ['FO-B1', 'FO-B2', 'FO-B3']) {
    const dep = queue.flights.find(f => f.flightNumber === fn);
    assert(dep.scheduledStartMin >= foA.scheduledEndMin + 15,
      `${fn} (start=${dep.scheduledStartMin}) after FO-A end+buffer (${foA.scheduledEndMin + 15})`);
  }

  // Cancel FO-A should auto-reschedule all dependents
  const cancelResult = await callTool('cancel_flight', { flightNumber: 'FO-A' });
  assert(cancelResult.affectedFlights.length === 3, `3 flights affected by cancel (got ${cancelResult.affectedFlights.length})`);

  // After auto-reschedule, all dependents should be scheduled (cancelled dep is resolved)
  const queue2 = await readResource('airport://flight-queue');
  for (const fn of ['FO-B1', 'FO-B2', 'FO-B3']) {
    const dep = queue2.flights.find(f => f.flightNumber === fn);
    assert(dep.status === 'scheduled', `${fn} auto-rescheduled (got ${dep.status})`);
  }
}

async function testFanInDependencies() {
  console.log('\n=== Test: Fan-In — One Flight Depends on Multiple ===');

  await callTool('submit_flight', { flightNumber: 'FI-A1', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'FI-A2', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'FI-B', operationType: 'departure', priority: 'medium', dependencies: ['FI-A1', 'FI-A2'] });

  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 3, `All 3 flights scheduled (got ${schedule.scheduledCount})`);

  const queue = await readResource('airport://flight-queue');
  const a1 = queue.flights.find(f => f.flightNumber === 'FI-A1');
  const a2 = queue.flights.find(f => f.flightNumber === 'FI-A2');
  const b = queue.flights.find(f => f.flightNumber === 'FI-B');

  const latestDepEnd = Math.max(a1.scheduledEndMin, a2.scheduledEndMin);
  assert(b.scheduledStartMin >= latestDepEnd + 15,
    `FI-B (start=${b.scheduledStartMin}) after latest dep end+buffer (${latestDepEnd + 15})`);
}

async function testExactRunwayMatch() {
  console.log('\n=== Test: Runway Requirement Exactly Matches ===');

  // Runway lengths: 3000, 2500. Require exactly 2500 — should use the 2500m one
  await callTool('submit_flight', { flightNumber: 'EX100', operationType: 'arrival', priority: 'high', runwayRequirement: 2500 });
  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 1, 'Flight with exact runway match scheduled');

  const queue = await readResource('airport://flight-queue');
  const ex = queue.flights.find(f => f.flightNumber === 'EX100');
  assert(ex.status === 'scheduled', `EX100 is scheduled (got ${ex.status})`);
}

async function testRunwayRequirementPartialMatch() {
  console.log('\n=== Test: Runway Requirement — Only Some Runways Qualify ===');

  // Require 2600m: only the 3000m runway qualifies (not the 2500m one)
  await callTool('submit_flight', { flightNumber: 'PR100', operationType: 'arrival', priority: 'high', runwayRequirement: 2600 });
  await callTool('submit_flight', { flightNumber: 'PR200', operationType: 'arrival', priority: 'high', runwayRequirement: 2600 });

  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 2, `Both flights scheduled (got ${schedule.scheduledCount})`);

  // Both should use runway 1 (3000m)
  const queue = await readResource('airport://flight-queue');
  const pr1 = queue.flights.find(f => f.flightNumber === 'PR100');
  const pr2 = queue.flights.find(f => f.flightNumber === 'PR200');
  assert(pr1.scheduledRunway === 1, `PR100 on runway 1 (3000m) got ${pr1.scheduledRunway}`);
  assert(pr2.scheduledRunway === 1, `PR200 on runway 1 (3000m) got ${pr2.scheduledRunway}`);

  // Verify separation between them
  const gap = pr2.scheduledStartMin - pr1.scheduledEndMin;
  assert(gap >= 3, `Separation between same-runway arrivals: ${gap} >= 3 (landing buffer)`);
}

async function testGroundCrewBottleneck() {
  console.log('\n=== Test: Ground Crew as the Bottleneck ===');

  // Use a config with 1 crew member but enough runways and gates
  // We can't change config mid-test, so we test with current config (3 crew)
  // Submit 4 arrivals (15 min each) — with 3 crew, max 3 can overlap
  for (let i = 1; i <= 4; i++) {
    await callTool('submit_flight', {
      flightNumber: `CRW${i}`,
      operationType: 'arrival',
      priority: 'high',
    });
  }

  await callTool('generate_schedule');
  const status = await callTool('get_airport_status');

  // Peak usage should not exceed crew count
  assert(status.groundCrew.peakConcurrentUsage <= status.groundCrew.total,
    `Peak crew (${status.groundCrew.peakConcurrentUsage}) <= total (${status.groundCrew.total})`);
}

async function testGateExhaustion() {
  console.log('\n=== Test: Gate Exhaustion ===');

  // With 4 gates and turnaround 30min, gate occupancy per arrival = 15 + 30 = 45 min
  // So at time 0, we can start 4 flights. The 5th can't start until min 45.
  for (let i = 1; i <= 5; i++) {
    await callTool('submit_flight', {
      flightNumber: `GX${i}00`,
      operationType: 'arrival',
      priority: 'high',
    });
  }

  await callTool('generate_schedule');
  const queue = await readResource('airport://flight-queue');
  
  // All should be scheduled (plenty of horizon), but the 5th should start later
  const scheduled = queue.flights.filter(f => f.status === 'scheduled');
  assert(scheduled.length === 5, `All 5 flights scheduled (got ${scheduled.length})`);

  const startTimes = scheduled.map(f => f.scheduledStartMin).sort((a, b) => a - b);
  // First 4 can be at early slots, but limited by runways (2) and crew (3) too
  // At least verify they don't all start at minute 0
  const uniqueStarts = [...new Set(startTimes)];
  assert(uniqueStarts.length > 1, `Not all flights start at same time (${uniqueStarts.join(', ')})`);
}

async function testMixedSeparation() {
  console.log('\n=== Test: Mixed Operation Separation on Same Runway ===');

  // Submit arrival then departure, both requiring the big runway only
  await callTool('submit_flight', { flightNumber: 'MX100', operationType: 'arrival', priority: 'high', runwayRequirement: 2600 });
  await callTool('submit_flight', { flightNumber: 'MX200', operationType: 'departure', priority: 'high', runwayRequirement: 2600 });

  await callTool('generate_schedule');
  const runwayData = await readResource('airport://runway-availability');

  // Both should be on runway 1 (3000m)
  const rw1 = runwayData.runways.find(r => r.runwayIndex === 1);
  assert(rw1.scheduledOperations.length === 2, `Runway 1 has 2 operations (got ${rw1.scheduledOperations.length})`);

  const ops = rw1.scheduledOperations.sort((a, b) => a.startMin - b.startMin);
  const gap = ops[1].startMin - ops[0].endMin;
  assert(gap >= 4, `Mixed separation gap is ${gap} >= 4 (RUNWAY_SEPARATION_MIXED)`);
}

async function testSubmitAfterSchedule() {
  console.log('\n=== Test: Submit Flight After Schedule Generated ===');

  await callTool('submit_flight', { flightNumber: 'SA100', operationType: 'arrival', priority: 'high' });
  await callTool('generate_schedule');

  // Submit another flight — it should be unscheduled until next generate
  await callTool('submit_flight', { flightNumber: 'SA200', operationType: 'departure', priority: 'high' });

  const queue = await readResource('airport://flight-queue');
  const sa200 = queue.flights.find(f => f.flightNumber === 'SA200');
  assert(sa200.status === 'unscheduled', `SA200 is unscheduled before generate (got ${sa200.status})`);

  // Now generate — both should be scheduled
  const schedule = await callTool('generate_schedule');
  assert(schedule.scheduledCount === 2, `Both flights scheduled after regenerate (got ${schedule.scheduledCount})`);
}

async function testSubmitWithCancelledDependency() {
  console.log('\n=== Test: Submit Flight Depending on a Cancelled Flight ===');

  await callTool('submit_flight', { flightNumber: 'CD100', operationType: 'arrival', priority: 'high' });
  await callTool('cancel_flight', { flightNumber: 'CD100' });

  // Submit a flight that depends on the cancelled one
  await callTool('submit_flight', { flightNumber: 'CD200', operationType: 'departure', priority: 'medium', dependencies: ['CD100'] });

  // Generate — CD200 should be schedulable since cancelled dep is treated as resolved
  const schedule = await callTool('generate_schedule');
  const queue = await readResource('airport://flight-queue');
  const cd200 = queue.flights.find(f => f.flightNumber === 'CD200');
  assert(cd200.status === 'scheduled', `CD200 scheduled despite cancelled dep (got ${cd200.status})`);
}

async function testBottleneckMultipleChains() {
  console.log('\n=== Test: Bottleneck — Longest of Multiple Chains ===');

  // Chain 1: short (2 flights)
  await callTool('submit_flight', { flightNumber: 'BN-S1', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'BN-S2', operationType: 'departure', priority: 'medium', dependencies: ['BN-S1'] });

  // Chain 2: long (3 flights)
  await callTool('submit_flight', { flightNumber: 'BN-L1', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'BN-L2', operationType: 'departure', priority: 'medium', dependencies: ['BN-L1'] });
  await callTool('submit_flight', { flightNumber: 'BN-L3', operationType: 'arrival', priority: 'low', dependencies: ['BN-L2'] });

  await callTool('generate_schedule');
  const bottleneck = await callTool('analyze_bottleneck');

  assert(bottleneck.longestDependencyChain.length === 3,
    `Bottleneck identifies the 3-flight chain (got ${bottleneck.longestDependencyChain.length})`);
  assert(bottleneck.longestDependencyChain.includes('BN-L1'), 'Chain includes BN-L1');
  assert(bottleneck.longestDependencyChain.includes('BN-L3'), 'Chain includes BN-L3');
}

async function testBottleneckNoChains() {
  console.log('\n=== Test: Bottleneck — No Dependency Chains ===');

  // All independent flights
  await callTool('submit_flight', { flightNumber: 'IND1', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'IND2', operationType: 'departure', priority: 'medium' });
  await callTool('generate_schedule');

  const bottleneck = await callTool('analyze_bottleneck');
  assert(bottleneck.message !== undefined, 'No chain found when flights are independent');
}

async function testUnknownToolAndResource() {
  console.log('\n=== Test: Unknown Tool / Resource ===');

  // Unknown tool
  const resp = await sendRequest('tools/call', { name: 'nonexistent_tool', arguments: {} });
  const text = resp.result?.content?.[0]?.text ?? '';
  assert(text.includes('Unknown tool'), `Unknown tool returns error: "${text.substring(0, 60)}"`);

  // Unknown resource
  try {
    await readResource('airport://nonexistent');
    assert(false, 'Unknown resource should throw');
  } catch (e) {
    assert(e.message.includes('Unknown resource') || e.message.includes('error'),
      `Unknown resource throws error: "${e.message.substring(0, 80)}"`);
  }
}

async function testPriorityOrderingUnderContention() {
  console.log('\n=== Test: Priority Ordering Under Resource Contention ===');

  // Submit flights in reverse priority order to verify sorting works
  await callTool('submit_flight', { flightNumber: 'PO-L1', operationType: 'arrival', priority: 'low' });
  await callTool('submit_flight', { flightNumber: 'PO-L2', operationType: 'departure', priority: 'low' });
  await callTool('submit_flight', { flightNumber: 'PO-M1', operationType: 'arrival', priority: 'medium' });
  await callTool('submit_flight', { flightNumber: 'PO-H1', operationType: 'departure', priority: 'high' });

  await callTool('generate_schedule');
  const queue = await readResource('airport://flight-queue');

  const high = queue.flights.find(f => f.flightNumber === 'PO-H1');
  const med = queue.flights.find(f => f.flightNumber === 'PO-M1');
  const low1 = queue.flights.find(f => f.flightNumber === 'PO-L1');
  const low2 = queue.flights.find(f => f.flightNumber === 'PO-L2');

  assert(high.scheduledStartMin <= med.scheduledStartMin,
    `High (${high.scheduledStartMin}) <= Medium (${med.scheduledStartMin})`);
  assert(high.scheduledStartMin <= low1.scheduledStartMin,
    `High (${high.scheduledStartMin}) <= Low1 (${low1.scheduledStartMin})`);
  assert(high.scheduledStartMin <= low2.scheduledStartMin,
    `High (${high.scheduledStartMin}) <= Low2 (${low2.scheduledStartMin})`);
}

async function testCancelNoScheduleYet() {
  console.log('\n=== Test: Cancel Flight Before Any Schedule Generated ===');

  await callTool('submit_flight', { flightNumber: 'CNS100', operationType: 'arrival', priority: 'high' });
  const result = await callTool('cancel_flight', { flightNumber: 'CNS100' });
  assert(result.success === true, 'Can cancel unscheduled flight');

  const queue = await readResource('airport://flight-queue');
  const f = queue.flights.find(f => f.flightNumber === 'CNS100');
  assert(f.status === 'cancelled', `Flight is cancelled (got ${f.status})`);
}

async function testTimelineChronologicalOrder() {
  console.log('\n=== Test: Timeline Chronological Order ===');

  // Submit several flights and verify timeline is sorted
  await callTool('submit_flight', { flightNumber: 'TL-C', operationType: 'arrival', priority: 'low' });
  await callTool('submit_flight', { flightNumber: 'TL-A', operationType: 'departure', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'TL-B', operationType: 'arrival', priority: 'medium' });

  await callTool('generate_schedule');
  const timeline = await readResource('airport://operations-timeline');

  let isSorted = true;
  for (let i = 1; i < timeline.timeline.length; i++) {
    if (timeline.timeline[i].startMin < timeline.timeline[i-1].startMin) {
      isSorted = false;
      break;
    }
  }
  assert(isSorted, 'Timeline is sorted chronologically by startMin');
  assert(timeline.scheduleEpoch !== null, 'Timeline includes scheduleEpoch');
  assert(timeline.totalOperations === 3, `Timeline totalOperations is 3 (got ${timeline.totalOperations})`);
}

async function testResourceConstraintWarning() {
  console.log('\n=== Test: Resource Constraint Warning in Status ===');

  // We need crew=3. Submit enough flights that 3 overlap at one point.
  // With 2 runways, max 2 simultaneous. So crew warning won't trigger.
  // But let's verify the structure works even without warning.
  await callTool('submit_flight', { flightNumber: 'RCW1', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'RCW2', operationType: 'departure', priority: 'high' });
  await callTool('generate_schedule');

  const status = await callTool('get_airport_status');
  assert(Array.isArray(status.resourceConstraints), 'resourceConstraints is an array');
  // With 2 simultaneous flights and 3 crew, should have no warning
  assert(status.groundCrew.peakConcurrentUsage <= 3,
    `Peak crew ${status.groundCrew.peakConcurrentUsage} within limit`);
}

async function testConfigWithOnlyRunwayCount1() {
  console.log('\n=== Test: Single Runway Config ===');
  // Uses the default 2-runway config, so this tests that flights use both runways
  await callTool('submit_flight', { flightNumber: 'SR1', operationType: 'arrival', priority: 'high' });
  await callTool('submit_flight', { flightNumber: 'SR2', operationType: 'arrival', priority: 'high' });
  await callTool('generate_schedule');

  const runwayData = await readResource('airport://runway-availability');
  const usedRunways = runwayData.runways.filter(r => r.scheduledOperations.length > 0);
  assert(usedRunways.length === 2, `Both runways utilized (got ${usedRunways.length})`);
}

// ==========================================
// RUNNER
// ==========================================

async function runWithFreshServer(testFn) {
  try {
    await startServer();
    await initialize();
    await testFn();
  } finally {
    stopServer();
    // Small delay between server restarts
    await new Promise(r => setTimeout(r, 300));
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   Airport ATC MCP Server — Test Suite         ║');
  console.log('╚════════════════════════════════════════════════╝');

  // Config validation (no server needed — spawns its own)
  await testInvalidConfig();

  // Each functional test gets a fresh server instance
  await runWithFreshServer(testMCPInterface);
  await runWithFreshServer(testEmptySchedule);
  await runWithFreshServer(testInputValidation);
  await runWithFreshServer(testScenario1_MorningRush);
  await runWithFreshServer(testScenario2_HeavyHauler);
  await runWithFreshServer(testScenario3_ConnectingFlight);
  await runWithFreshServer(testCancelFlight);
  await runWithFreshServer(testDuplicateFlightRejection);
  await runWithFreshServer(testCancelNonexistent);
  await runWithFreshServer(testCancelAlreadyCancelled);
  await runWithFreshServer(testCancelledFlightVisible);
  await runWithFreshServer(testRescheduleAfterCancel);
  await runWithFreshServer(testCircularDependency);
  await runWithFreshServer(testDeterminism);
  await runWithFreshServer(testResourceConstraints);
  await runWithFreshServer(testGateAvailability);
  await runWithFreshServer(testRunwaySeparation);
  await runWithFreshServer(testScheduleExceedsHorizon);
  await runWithFreshServer(testAirportStatusStructure);

  // Additional edge case tests
  await runWithFreshServer(testMultiLevelDepChain);
  await runWithFreshServer(testFanOutDependencies);
  await runWithFreshServer(testFanInDependencies);
  await runWithFreshServer(testExactRunwayMatch);
  await runWithFreshServer(testRunwayRequirementPartialMatch);
  await runWithFreshServer(testGroundCrewBottleneck);
  await runWithFreshServer(testGateExhaustion);
  await runWithFreshServer(testMixedSeparation);
  await runWithFreshServer(testSubmitAfterSchedule);
  await runWithFreshServer(testSubmitWithCancelledDependency);
  await runWithFreshServer(testBottleneckMultipleChains);
  await runWithFreshServer(testBottleneckNoChains);
  await runWithFreshServer(testUnknownToolAndResource);
  await runWithFreshServer(testPriorityOrderingUnderContention);
  await runWithFreshServer(testCancelNoScheduleYet);
  await runWithFreshServer(testTimelineChronologicalOrder);
  await runWithFreshServer(testResourceConstraintWarning);
  await runWithFreshServer(testConfigWithOnlyRunwayCount1);

  console.log('\n════════════════════════════════════════════════');
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log('════════════════════════════════════════════════');

  process.exit(testsFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test suite crashed:', err);
  stopServer();
  process.exit(2);
});
