/* Reproducible virtual-only validation. This script never connects to a broker or actuator. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const ts = require('typescript');
const { FakeClock, VirtualGate, harness } = require('../test/helpers/VirtualGate');

async function legacyBaseline() {
  const commit = '18de144d81c04ba3ea40cbc77ce7e78fe73b237d';
  const source = execFileSync('git', ['show', `${commit}:src/Accesories/FrontGateFsm.ts`], { encoding: 'utf8' });
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const clock = new FakeClock();
  clock.time = 1000000;
  class SimDate extends Date { static now() { return clock.now(); } }
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module, exports: module.exports, Date: SimDate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  let controller;
  let pulses = 0;
  const plant = new VirtualGate(clock, closed => controller.handleClosedSensorChange(closed));
  controller = new module.exports.FrontGateFsm({
    pulseMotor: async () => { pulses++; plant.pulse(); }, publishSnapshot() {}, log: { debug() {}, info() {}, warn() {} },
  });
  controller.handleControlConnectedChange(true);
  controller.handleSensorConnectedChange(true);
  controller.handleClosedSensorChange(true);
  await clock.flush();
  await controller.requestHomeKitTarget('open');
  await clock.tick(1000);
  plant.pulse();
  await clock.tick(3000);
  plant.pulse();
  await clock.tick(1000);
  const result = { commit, pluginPulsesAfterUnexpectedClosure: pulses, physicalState: plant.state, expectedPluginPulses: 1 };
  controller.dispose();
  assert.equal(pulses, 2, 'immutable baseline reproduces automatic reopening');
  return result;
}

async function userSequence() {
  const h = harness();
  const trace = [];
  const record = label => {
    const snapshot = h.snapshot();
    trace.push({ label, at: h.clock.now(), actual: h.plant.state, position: h.plant.position,
      estimated: snapshot.estimate.kind === 'moving' ? snapshot.estimate.direction : snapshot.estimate.kind,
      nextPulse: snapshot.nextPulseDirection });
  };
  record('closed');
  h.visiblePulse(); record('open');
  await h.clock.tick(10000); h.visiblePulse(); record('stop after opening');
  await h.clock.tick(3000); h.visiblePulse(); record('close');
  await h.clock.tick(5000); h.visiblePulse(); record('stop after closing');
  await h.clock.tick(3000); h.visiblePulse(); record('open again');
  h.dispose();
  return trace;
}

async function wrongDirection() {
  const h = harness({ unknownTargetPolicy: 'single_pulse_best_effort' });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(20000);
  h.hiddenPulse();
  await h.clock.tick(10000);
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(20000);
  const atFailure = h.snapshot();
  const pulsesAtFailure = h.attempts.length;
  await h.clock.tick(250000);
  const result = { atFailure, pulsesAtFailure, pulsesAfter250Seconds: h.attempts.length, physicalFinal: h.plant.state };
  assert.equal(atFailure.currentDoorState, 1);
  assert.equal(atFailure.targetDoorState, 1);
  assert.equal(atFailure.activeRequest, null);
  assert.equal(h.attempts.length, pulsesAtFailure);
  h.dispose();
  return result;
}

async function main() {
  const tests = fs.readdirSync(path.resolve('test')).filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`);
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { encoding: 'utf8' });
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/gate-tests.tap', run.stdout ?? '');
  if (run.status !== 0) {
    process.stderr.write((run.stdout ?? '') + (run.stderr ?? ''));
    throw run.error ?? new Error('Gate tests failed');
  }
  const count = field => Number(run.stdout.match(new RegExp(`^# ${field} (\\d+)$`, 'm'))?.[1]);
  const report = {
    artifact: 'Production FrontGateFsm and adapter validation', generatedAt: new Date().toISOString(), node: process.version,
    packageVersion: require('../package.json').version,
    homebridgeDependency: JSON.parse(fs.readFileSync('node_modules/homebridge/package.json', 'utf8')).version,
    tests: count('tests'), passed: count('pass'), failed: count('fail'),
    boundedVisibleHistories: 4096, stepsPerVisibleHistory: 6, seededFaultHistories: 2000, stepsPerFaultHistory: 15,
    baseline: await legacyBaseline(), userSequence: await userSequence(), wrongDirection: await wrongDirection(),
    assumptions: [
      'Virtual nominal plant: 25 seconds per full traversal, closed-only contact, endpoint/stop/reverse button semantics.',
      'Nominal scenarios use zero transport and sensor lag; additional tests exercise intervals, relay hold, debounce and callback ordering.',
      'Applied-pulse visibility is an explicit simulated upgrade; raw MQTT and native acceptance are interference only.',
      'History enumeration is bounded over the defined test alphabet, not exhaustive over real hardware behavior.',
      'MQTT adapters use mocks plus real MQTT.js offline-queue behavior; HAP characteristic handlers use the installed Homebridge dependency.',
      'No physical gate, live broker, Apple Home UI or SRPC sidecar deployment was tested.',
    ],
  };
  assert.ok(report.tests > 0 && report.failed === 0 && report.passed === report.tests);
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/gate-validation.json', JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`${report.passed} tests passed; report: docs/gate-validation.json\n`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
