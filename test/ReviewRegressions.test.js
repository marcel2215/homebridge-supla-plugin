// Reconstructed from the supplied review; R3 exercises the real HAP adapter in GateAdapters.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FrontGateFsm, DoorCurrentState: Current, DoorTargetState: Target } = require('../dist/Accesories/FrontGateFsm');
const { FakeClock, VirtualGate, harness } = require('./helpers/VirtualGate');

const log = { debug() {}, info() {}, warn() {} };
function setup(t, options) {
  const h = harness(options);
  t.after(h.dispose);
  return h;
}

async function reversal(t, { stopDelay = 2500, reverseDelay = 0, ...timings } = {}) {
  const clock = new FakeClock();
  const applied = [];
  let controller;
  const plant = new VirtualGate(clock, closed => controller.handleClosedSensorChange(closed), {
    relayHighMs: timings.relayHighMs ?? 500,
  });
  controller = new FrontGateFsm({
    pulseMotor: async reason => {
      clock.setTimeout(() => {
        plant.pulse();
        applied.push({ reason, at: clock.now(), state: plant.state });
      }, reason === 'stop-opening' ? stopDelay : reason === 'start-closing' ? reverseDelay : 0);
    },
    publishSnapshot() {}, log,
  }, { allowSpeculativeSequences: true, ...timings }, clock);
  t.after(() => controller.dispose());
  controller.handleTransportConnectedChange(true);
  controller.handleControlConnectedChange(true);
  controller.handleSensorConnectedChange(true);
  controller.handleClosedSensorChange(true);
  await controller.requestHomeKitTarget('open');
  await clock.tick(10000);
  await controller.requestHomeKitTarget('closed');
  await clock.tick(20000);
  assert.deepEqual(applied.map(edge => edge.state), ['opening', 'stopped', 'closing']);
  return applied[2].at - applied[1].at;
}

test('R1: late stop delivery and early reversal preserve the configured pause at the motor', async t => {
  const pause = await reversal(t);
  assert.ok(pause >= 3000, `configured 3000 ms reversal pause became ${pause} ms at the motor`);
});

test('R1: delivery skew preserves reversal, minimum-gap and relay-release bounds across timing configurations', async t => {
  for (const timings of [
    { reversePauseMs: 3000, minimumPulseGapMs: 3000, relayHighMs: 500, relayReleaseMarginMs: 500 },
    { reversePauseMs: 5000, minimumPulseGapMs: 3000, relayHighMs: 500, relayReleaseMarginMs: 500 },
    { reversePauseMs: 3000, minimumPulseGapMs: 5000, relayHighMs: 500, relayReleaseMarginMs: 500 },
    { reversePauseMs: 3000, minimumPulseGapMs: 3000, relayHighMs: 4000, relayReleaseMarginMs: 1000 },
  ]) {
    for (const stopDelay of [0, 500, 2500]) {
      for (const reverseDelay of [0, 750, 2500]) {
        const config = { ...timings, stopDelay, reverseDelay };
        const pause = await reversal(t, config);
        assert.ok(pause >= timings.reversePauseMs, JSON.stringify(config));
        assert.ok(pause >= timings.minimumPulseGapMs, JSON.stringify(config));
        assert.ok(pause >= timings.relayHighMs + timings.relayReleaseMarginMs, JSON.stringify(config));
      }
    }
  }
});

test('R1: a genuinely observed edge uses its applied timestamp without another delivery allowance', async t => {
  const h = setup(t, { actuationDelayMs: 2500, unknownTargetPolicy: 'single_pulse_best_effort' });
  await h.clock.tick(100);
  h.visiblePulse();
  await h.clock.tick(10000);
  h.visiblePulse();
  await h.controller.requestHomeKitTarget('closed');
  await h.clock.tick(2999);
  assert.equal(h.attempts.length, 0);
  await h.clock.tick(1);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].at, 13100);
});

test('R2: rejecting OPEN during closing projects CLOSED without restoring a request', async t => {
  const h = setup(t, { assumeOpenAfterTravel: true });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(25000);
  await h.controller.requestHomeKitTarget('closed');
  await h.clock.tick(1000);
  await assert.rejects(h.controller.requestHomeKitTarget('open'), /opt-in/);
  const snapshot = h.snapshot();
  assert.equal(snapshot.currentDoorState, Current.CLOSING);
  assert.equal(snapshot.targetDoorState, Target.CLOSED);
  assert.equal(snapshot.requestedTarget, null);
  assert.equal(snapshot.activeRequest, null);
  assert.equal(snapshot.lastResult.outcome, 'rejected');
  await h.clock.tick(250000);
  assert.equal(h.attempts.length, 2);
  assert.equal(h.plant.state, 'closed');
});

test('R4: an applied pulse older than a fresh zero-lag CLOSED anchor cannot invent opening', async t => {
  const h = setup(t);
  h.visiblePulse();
  await h.clock.tick(5);
  h.visiblePulse();
  await h.clock.tick(5);
  h.contacts(false);
  h.hiddenPulse(); // Closing edge at 10 ms; its stronger-telemetry event arrives later.
  await h.clock.tick(190);
  h.controller.handleClosedSensorChange(true);
  await h.clock.tick(10);
  h.controller.handleAppliedPulse(undefined, 10);
  assert.equal(h.plant.state, 'closed');
  assert.equal(h.snapshot().closedSensor, true);
  assert.equal(h.snapshot().estimate.kind, 'closed');
  assert.equal(h.snapshot().currentDoorState, Current.CLOSED);
  assert.equal(h.attempts.length, 0);
});

test('R5: unchanged CLOSED before the first OPEN pulse preserves the original request', async t => {
  const h = setup(t);
  h.controller.handleCommandIntent('external');
  await h.clock.tick(100);
  h.controller.handleClosedSensorChange(true);
  await h.controller.requestHomeKitTarget('open');
  const request = h.snapshot().activeRequest;
  assert.equal(request.attempts, 0);
  await h.clock.tick(100);
  h.controller.handleClosedSensorChange(true);
  assert.equal(h.snapshot().activeRequest?.id, request.id);
  await h.clock.tick(4000);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].requestId, request.id);
  assert.equal(h.plant.motion, 'opening');
  await h.clock.tick(250000);
  assert.equal(h.attempts.length, 1);
});

test('R4: provably obsolete execution evidence cannot cancel a newer waiting request', async t => {
  const h = setup(t);
  h.controller.handleCommandIntent('external');
  await h.clock.tick(200);
  h.controller.handleClosedSensorChange(true);
  await h.controller.requestHomeKitTarget('open');
  const id = h.snapshot().activeRequest.id;
  await h.clock.tick(10);
  h.controller.handleAppliedPulse(undefined, 10);
  assert.equal(h.snapshot().activeRequest?.id, id);
  assert.equal(h.snapshot().estimate.kind, 'closed');
  await h.clock.tick(3000);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].requestId, id);
});

test('R4: an edge before CLOSED preserves the anchor while still respecting its relay-release interval', async t => {
  const h = setup(t);
  await h.clock.tick(200);
  h.controller.handleClosedSensorChange(true);
  await h.clock.tick(10);
  h.controller.handleAppliedPulse(undefined, 10);
  assert.equal(h.snapshot().estimate.kind, 'closed');
  await h.controller.requestHomeKitTarget('open');
  assert.equal(h.attempts.length, 0);
  await h.clock.tick(2799);
  assert.equal(h.attempts.length, 0);
  await h.clock.tick(1);
  assert.equal(h.attempts.length, 1);
});

for (const retained of [false, true]) {
  test(`R4: ${retained ? 'retained' : 'lagged'} CLOSED evidence cannot establish ordering for an overlapping edge`, async t => {
    const h = setup(t, { sensorDelayMs: 250 });
    h.controller.handleSensorConnectedChange(false);
    h.controller.handleSensorConnectedChange(true);
    await h.clock.tick(200);
    h.controller.handleClosedSensorChange(true, { retained });
    await h.clock.tick(10);
    h.controller.handleAppliedPulse(undefined, 10);
    assert.equal(h.snapshot().closedSensor, true);
    assert.equal(h.snapshot().estimate.kind, 'unknown');
    await assert.rejects(h.controller.requestHomeKitTarget('open'), /unknown/);
    assert.equal(h.attempts.length, 0);
  });
}

test('R4: a newer applied edge is ordered against contact receipt, not its later debounce commitment', async t => {
  const h = setup(t, { sensorDelayMs: 100 });
  await h.clock.tick(400);
  h.controller.handleClosedSensorChange(true, { receivedAt: 200 });
  await h.clock.tick(10);
  h.controller.handleAppliedPulse(undefined, 300);
  assert.equal(h.snapshot().estimate.direction, 'opening');
  assert.equal(h.snapshot().estimate.startedAt, 300);
  assert.equal(h.attempts.length, 0);
});

test('R5: a newly observed closure still terminates a zero-attempt best-effort OPEN', async t => {
  const h = setup(t, { unknownTargetPolicy: 'single_pulse_best_effort' });
  h.contacts(false);
  h.controller.handleClosedSensorChange(false);
  h.controller.handleCommandIntent('external');
  await h.controller.requestHomeKitTarget('open');
  assert.equal(h.snapshot().activeRequest.attempts, 0);
  h.controller.handleClosedSensorChange(true);
  assert.equal(h.snapshot().lastResult.reason, 'target-mismatch-closed');
  await h.clock.tick(250000);
  assert.equal(h.attempts.length, 0);
});
