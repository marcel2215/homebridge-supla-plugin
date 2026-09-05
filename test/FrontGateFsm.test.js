const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DoorCurrentState: Current, DoorTargetState: Target } = require('../dist/Accesories/FrontGateFsm');
const { harness } = require('./helpers/VirtualGate');

function setup(t, options, plantOptions) {
  const h = harness(options, plantOptions);
  t.after(() => h.dispose());
  return h;
}

test('closed startup is authoritative; unknown nonclosed startup rejects both targets', async t => {
  const h = setup(t);
  assert.equal(h.snapshot().currentDoorState, Current.CLOSED);
  h.controller.handleTransportConnectedChange(false);
  h.controller.handleTransportConnectedChange(true);
  h.controller.handleControlConnectedChange(true);
  h.controller.handleSensorConnectedChange(true);
  h.controller.handleClosedSensorChange(false);
  for (const target of ['open', 'closed']) await assert.rejects(h.controller.requestHomeKitTarget(target), /direction unknown/);
  assert.equal(h.snapshot().currentDoorState, Current.STOPPED);
  assert.equal(h.attempts.length, 0);
});

test('ordinary OPEN finishes unconfirmed by default; GETs and timers never actuate', async t => {
  const h = setup(t);
  await h.controller.requestHomeKitTarget('open');
  assert.equal(h.snapshot().estimate.kind, 'moving');
  await h.clock.tick(25000);
  assert.equal(h.plant.state, 'open');
  assert.equal(h.snapshot().currentDoorState, Current.STOPPED);
  assert.equal(h.snapshot().activeRequest, null);
  for (let i = 0; i < 20; i++) h.snapshot();
  await h.clock.tick(250000);
  assert.equal(h.attempts.length, 1);
});

test('estimated OPEN is opt-in and CLOSE succeeds only on the contact', async t => {
  const h = setup(t, { assumeOpenAfterTravel: true });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(25000);
  assert.equal(h.snapshot().currentDoorState, Current.OPEN);
  assert.equal(h.snapshot().lastResult.outcome, 'estimated');
  await h.controller.requestHomeKitTarget('closed');
  await h.clock.tick(25000);
  assert.equal(h.snapshot().currentDoorState, Current.CLOSED);
  assert.equal(h.snapshot().lastResult.outcome, 'confirmed');
  assert.equal(h.attempts.length, 2);
});

test('OPEN actually closes: reset both HomeKit values to CLOSED and never reopen', async t => {
  const h = setup(t, { unknownTargetPolicy: 'single_pulse_best_effort' });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(20000);
  h.hiddenPulse(); // Hidden stop: the next physical edge now closes.
  await h.clock.tick(10000);
  await h.controller.requestHomeKitTarget('open');
  assert.equal(h.plant.motion, 'closing');
  await h.clock.tick(20000);
  const failed = h.snapshot();
  assert.equal(failed.currentDoorState, Current.CLOSED);
  assert.equal(failed.targetDoorState, Target.CLOSED);
  assert.equal(failed.requestedTarget, null);
  assert.equal(failed.activeRequest, null);
  assert.equal(failed.nextPulseDirection, 'opening');
  assert.equal(failed.lastResult.reason, 'target-mismatch-closed');
  await h.clock.tick(250000);
  assert.equal(h.attempts.length, 2);
  assert.equal(h.plant.state, 'closed');
  await h.controller.requestHomeKitTarget('open');
  assert.equal(h.attempts.length, 3, 'a new explicit request is new authorization');
});

test('open-stop-close-stop-open observed edges preserve next direction without requests', async t => {
  const h = setup(t);
  h.visiblePulse();
  await h.clock.tick(10000);
  h.visiblePulse();
  assert.equal(h.snapshot().estimate.kind, 'stopped');
  assert.equal(h.snapshot().nextPulseDirection, 'closing');
  await h.clock.tick(3000);
  h.visiblePulse();
  await h.clock.tick(5000);
  h.visiblePulse();
  assert.equal(h.snapshot().nextPulseDirection, 'opening');
  await h.clock.tick(3000);
  h.visiblePulse();
  assert.equal(h.snapshot().estimate.direction, 'opening');
  assert.ok(Math.abs(h.snapshot().position.min - 0.2) < 1e-9);
  assert.equal(h.snapshot().activeRequest, null);
  assert.equal(h.attempts.length, 0);
});

test('partial reversals use remaining travel and avoid an unnecessary second CLOSE pulse', async t => {
  const h = setup(t, { assumeOpenAfterTravel: true, allowSpeculativeSequences: true });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(20000);
  await h.controller.requestHomeKitTarget('closed');
  await h.clock.tick(3000);
  await h.clock.tick(3000);
  assert.ok(Math.abs(h.plant.position - 0.68) < 1e-9);
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(3000);
  const remaining = h.snapshot().estimate.latestEnd - h.clock.now();
  assert.ok(Math.abs(remaining - 8000) < 1e-8);
  await h.clock.tick(8000);
  assert.equal(h.plant.state, 'open');
  assert.equal(h.snapshot().estimate.kind, 'open');
  await h.controller.requestHomeKitTarget('closed');
  assert.equal(h.snapshot().activeRequest.pulseBudget, 1);
  await h.clock.tick(3000);
  assert.equal(h.plant.motion, 'closing');
  assert.equal(h.attempts.length, 6);
});

test('speculative reversal is disabled by default without disrupting the physical estimate', async t => {
  const h = setup(t);
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(10000);
  await assert.rejects(h.controller.requestHomeKitTarget('closed'), /opt-in/);
  assert.equal(h.snapshot().estimate.direction, 'opening');
  assert.equal(h.snapshot().activeRequest, null);
  await h.clock.tick(30000);
  assert.equal(h.attempts.length, 1);
});

test('endpoint uncertainty rejects a stop/reverse even with compatibility enabled', async t => {
  const h = setup(t, { travelUncertainty: 0.2, actuationDelayMs: 1000, allowSpeculativeSequences: true });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(19500);
  await assert.rejects(h.controller.requestHomeKitTarget('closed'), /remaining-travel/);
  assert.equal(h.attempts.length, 1);
});

test('asymmetric travel times and start delay widen the position interval', async t => {
  const h = setup(t, {
    openingTravelMs: 20000, closingTravelMs: 40000, travelUncertainty: 0.1, actuationDelayMs: 2000, assumeOpenAfterTravel: true,
  }, { openingMs: 20000, closingMs: 40000 });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(10000);
  const { min, max } = h.snapshot().position;
  assert.ok(min <= h.plant.position && max >= h.plant.position && max > min);
  assert.equal(h.snapshot().estimate.earliestEnd, 18000);
  assert.equal(h.snapshot().estimate.latestEnd, 24000);
  await h.clock.tick(14000);
  await h.controller.requestHomeKitTarget('closed');
  await h.clock.tick(20000);
  assert.ok(h.snapshot().position.min <= h.plant.position && h.snapshot().position.max >= h.plant.position);
  await h.clock.tick(20000);
  assert.equal(h.snapshot().lastResult.outcome, 'confirmed');
  assert.equal(h.plant.state, 'closed');
  assert.equal(h.attempts.length, 2);
});

test('active same-target SETs deduplicate; following an external movement allocates zero pulses', async t => {
  const h = setup(t);
  h.visiblePulse();
  await h.clock.tick(4000);
  await h.controller.requestHomeKitTarget('open');
  const id = h.snapshot().activeRequest.id;
  await h.controller.requestHomeKitTarget('open');
  assert.equal(h.snapshot().activeRequest.id, id);
  assert.equal(h.snapshot().activeRequest.pulseBudget, 0);
  await h.clock.tick(25000);
  assert.equal(h.attempts.length, 0);
  assert.equal(h.snapshot().activeRequest, null);
});

for (const mode of ['timeout-delivered', 'timeout-not-delivered', 'error-delivered', 'error-not-delivered']) {
  test(`${mode}: delivery ambiguity terminates; old callbacks cannot revive work`, async t => {
    const h = setup(t, { unknownTargetPolicy: 'single_pulse_best_effort', allowSpeculativeSequences: true });
    h.mode(mode);
    await h.controller.requestHomeKitTarget('open');
    await h.clock.tick(2501);
    assert.equal(h.snapshot().activeRequest, null);
    assert.equal(h.snapshot().estimate.kind, 'unknown');
    for (const pending of h.pending) pending.resolve();
    await h.clock.tick(250000);
    assert.equal(h.attempts.length, 1);
    assert.equal(h.snapshot().activeRequest, null);
    await h.controller.requestHomeKitTarget('closed');
    assert.equal(h.attempts.length, 2);
  });
}

test('a definite not-sent result preserves the estimate but clears intent', async t => {
  const h = setup(t);
  h.mode('not-sent');
  await h.controller.requestHomeKitTarget('open');
  await h.clock.flush();
  assert.equal(h.snapshot().estimate.kind, 'closed');
  assert.equal(h.snapshot().requestedTarget, null);
  assert.equal(h.snapshot().lastResult.reason, 'not-sent');
  await h.clock.tick(3000);
  await h.controller.requestHomeKitTarget('open');
  assert.equal(h.plant.motion, 'opening');
});

for (const cancel of ['external', 'offline', 'sensor-offline', 'closed', 'disposed', 'debounce-edge']) {
  test(`${cancel} during reversal pause cancels the unsent step`, async t => {
    const h = setup(t, { allowSpeculativeSequences: true });
    await h.controller.requestHomeKitTarget('open');
    await h.clock.tick(10000);
    await h.controller.requestHomeKitTarget('closed');
    await h.clock.flush();
    assert.equal(h.attempts.length, 2);
    assert.equal(h.snapshot().estimate.kind, 'stopped');
    if (cancel === 'external') h.controller.handleCommandIntent('external');
    if (cancel === 'offline') h.controller.handleTransportConnectedChange(false);
    if (cancel === 'sensor-offline') h.controller.handleSensorConnectedChange(false);
    if (cancel === 'closed') h.controller.handleClosedSensorChange(true);
    if (cancel === 'disposed') h.controller.dispose();
    if (cancel === 'debounce-edge') h.controller.handleContactTransition();
    await h.clock.tick(250000);
    assert.equal(h.attempts.length, 2);
    assert.equal(h.snapshot().activeRequest, null);
  });
}

test('superseding a reversal preserves stopped direction and rejects a wrong-way plan', async t => {
  const h = setup(t, { allowSpeculativeSequences: true });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(10000);
  await h.controller.requestHomeKitTarget('closed');
  await h.clock.flush();
  await assert.rejects(h.controller.requestHomeKitTarget('open'), /wrong-way/);
  assert.equal(h.snapshot().nextPulseDirection, 'closing');
  assert.equal(h.snapshot().activeRequest, null);
  await h.clock.tick(3000);
  await h.controller.requestHomeKitTarget('closed');
  assert.equal(h.snapshot().activeRequest.pulseBudget, 1);
  assert.equal(h.plant.motion, 'closing');
});

test('offline before a late publication callback invalidates immediately and reconnect never replays', async t => {
  const h = setup(t);
  h.mode('timeout-delivered');
  await h.controller.requestHomeKitTarget('open');
  h.controller.handleTransportConnectedChange(false);
  assert.equal(h.snapshot().available, false);
  assert.equal(h.snapshot().activeRequest, null);
  h.pending[0].resolve();
  await h.clock.flush();
  h.controller.handleTransportConnectedChange(true);
  h.controller.handleControlConnectedChange(true);
  h.controller.handleSensorConnectedChange(true);
  assert.equal(h.snapshot().available, false);
  h.controller.handleClosedSensorChange(false, { retained: true });
  assert.equal(h.snapshot().estimate.kind, 'unknown');
  await h.clock.tick(250000);
  assert.equal(h.attempts.length, 1);
});

test('closed evidence before publication completion is never overwritten by the callback', async t => {
  const h = setup(t);
  h.mode('timeout-delivered');
  await h.controller.requestHomeKitTarget('open');
  h.controller.handleClosedSensorChange(true);
  h.pending[0].resolve();
  await h.clock.tick(250000);
  assert.equal(h.snapshot().targetDoorState, Target.CLOSED);
  assert.equal(h.snapshot().currentDoorState, Current.CLOSED);
  assert.equal(h.attempts.length, 1);
});

test('retained/stale contacts during departure do not restore the old closed anchor', async t => {
  const h = setup(t);
  await h.controller.requestHomeKitTarget('open');
  h.controller.handleClosedSensorChange(true, { retained: true });
  h.controller.handleClosedSensorChange(true, { stale: true });
  h.controller.handleClosedSensorChange(true, { epoch: -1 });
  assert.equal(h.snapshot().estimate.direction, 'opening');
  assert.ok(h.snapshot().activeRequest);
});

test('cached CLOSED during startup grace does not terminate OPEN; a later repeated live CLOSED can repair it', async t => {
  const h = setup(t);
  h.contacts(false);
  await h.controller.requestHomeKitTarget('open');
  h.controller.handleClosedSensorChange(true);
  assert.ok(h.snapshot().activeRequest);
  await h.clock.tick(4500);
  h.controller.handleClosedSensorChange(true);
  assert.equal(h.snapshot().estimate.kind, 'closed');
  assert.equal(h.snapshot().targetDoorState, Target.CLOSED);
  assert.equal(h.snapshot().activeRequest, null);
});

test('contact release and correlated own relay observation do not restart travel or count another pulse', async t => {
  const h = setup(t);
  h.contacts(false);
  await h.controller.requestHomeKitTarget('open');
  const end = h.snapshot().estimate.latestEnd;
  h.controller.handleAppliedPulse(h.attempts[0].correlationId);
  h.controller.handleAppliedPulse(h.attempts[0].correlationId);
  await h.clock.tick(1000);
  h.controller.handleClosedSensorChange(false);
  assert.equal(h.snapshot().estimate.latestEnd, end);
  assert.equal(h.snapshot().estimate.direction, 'opening');
  assert.equal(h.attempts.length, 1);
});

test('external activity and ambiguous local attempts enforce spacing for the next explicit request', async t => {
  const h = setup(t, { unknownTargetPolicy: 'single_pulse_best_effort' });
  h.controller.handleCommandIntent('external');
  await h.controller.requestHomeKitTarget('closed');
  assert.equal(h.attempts.length, 0);
  await h.clock.tick(2999);
  assert.equal(h.attempts.length, 0);
  await h.clock.tick(1);
  assert.equal(h.attempts.length, 1);
});

test('a hidden stop never becomes confirmed or estimated OPEN with conservative settings', async t => {
  const h = setup(t);
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(10000);
  h.hiddenPulse();
  await h.clock.tick(250000);
  assert.equal(h.plant.state, 'stopped');
  assert.equal(h.snapshot().currentDoorState, Current.STOPPED);
  assert.equal(h.attempts.length, 1);
});

test('relay-high allowance prevents coalescing a planned stop and reverse', async t => {
  const h = setup(t, { allowSpeculativeSequences: true, relayHighMs: 4000, relayReleaseMarginMs: 1000 }, { relayHighMs: 4000 });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(10000);
  await h.controller.requestHomeKitTarget('closed');
  await h.clock.tick(4999);
  assert.equal(h.attempts.length, 2);
  await h.clock.tick(1);
  assert.equal(h.attempts.length, 3);
  assert.equal(h.plant.edges, 3);
  assert.equal(h.plant.motion, 'closing');
});

test('4096 six-step visible-event histories preserve budgets and terminal barriers', async () => {
  for (let history = 0; history < 4096; history++) {
    const h = harness({ allowSpeculativeSequences: true, unknownTargetPolicy: 'single_pulse_best_effort' });
    let code = history;
    for (let step = 0; step < 6; step++, code >>= 2) {
      const action = code & 3;
      if (action < 2) await h.controller.requestHomeKitTarget(action === 0 ? 'open' : 'closed').catch(() => {});
      if (action === 2) h.visiblePulse();
      await h.clock.tick(3500);
      h.check();
    }
    await h.clock.tick(250000);
    h.check();
    h.dispose();
  }
});

test('2000 seeded 15-step fault histories never expand a pulse budget or revive a terminal request', async () => {
  let seed = 0x5eeda11;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let history = 0; history < 2000; history++) {
    const h = harness({ allowSpeculativeSequences: true, unknownTargetPolicy: 'single_pulse_best_effort' });
    for (let step = 0; step < 15; step++) {
      switch (random() % 9) {
        case 0: case 1: await h.controller.requestHomeKitTarget(random() & 1 ? 'open' : 'closed').catch(() => {}); break;
        case 2: h.hiddenPulse(); break;
        case 3: h.controller.handleCommandIntent('ambiguous'); break;
        case 4: h.mode(random() & 1 ? 'timeout-delivered' : 'timeout-not-delivered'); break;
        case 5: h.controller.handleTransportConnectedChange(false); break;
        case 6:
          h.controller.handleTransportConnectedChange(true);
          h.controller.handleControlConnectedChange(true);
          h.controller.handleSensorConnectedChange(true);
          h.controller.handleClosedSensorChange(h.plant.state === 'closed', { retained: true });
          break;
        case 7: for (const pending of h.pending) pending.resolve(); break;
        case 8: h.controller.handleClosedSensorChange(true, { stale: true }); break;
      }
      await h.clock.tick(random() % 6000);
      h.check();
    }
    await h.clock.tick(250000);
    h.check();
    h.dispose();
  }
});

test('a hidden remote stop/close during OPEN reaches CLOSED with no automatic reopening', async t => {
  const h = setup(t);
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(1000);
  h.hiddenPulse();
  await h.clock.tick(3000);
  h.hiddenPulse();
  await h.clock.tick(1000);
  assert.equal(h.snapshot().currentDoorState, Current.CLOSED);
  assert.equal(h.snapshot().targetDoorState, Target.CLOSED);
  await h.clock.tick(250000);
  assert.equal(h.attempts.length, 1);
});

test('a retained CLOSED replay after ambiguous delivery cannot repair the live estimate', async t => {
  const h = setup(t);
  h.mode('timeout-delivered');
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(3000);
  h.controller.handleClosedSensorChange(true, { retained: true });
  assert.equal(h.snapshot().estimate.kind, 'unknown');
  await assert.rejects(h.controller.requestHomeKitTarget('open'), /unknown/);
  assert.equal(h.attempts.length, 1);
});

test('a delayed first stop is rechecked if the endpoint becomes possible during pulse spacing', async t => {
  const h = setup(t, { allowSpeculativeSequences: true, assumeOpenAfterTravel: true, minimumPulseGapMs: 30000 });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(10000);
  await h.controller.requestHomeKitTarget('closed');
  assert.equal(h.snapshot().activeRequest.phase, 'waiting');
  await h.clock.tick(30000);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.plant.state, 'open');
  assert.equal(h.snapshot().activeRequest, null);
  assert.equal(h.snapshot().lastResult.outcome, 'failed');
});

test('external contact-reporting lag widens the departure interval and guards the earlier physical endpoint', async t => {
  const h = setup(t, { sensorDelayMs: 10000, allowSpeculativeSequences: true });
  h.contacts(false);
  h.hiddenPulse();
  await h.clock.tick(10000);
  h.controller.handleClosedSensorChange(false);
  assert.ok(h.snapshot().position.max >= h.plant.position);
  assert.ok(h.snapshot().position.min <= h.plant.position);
  assert.equal(h.snapshot().estimate.earliestEnd, 25000);
  await h.clock.tick(15000);
  await assert.rejects(h.controller.requestHomeKitTarget('closed'), /remaining-travel/);
  assert.equal(h.attempts.length, 0);
});

test('late own execution evidence cancels the request instead of confirming an obsolete timeline', async t => {
  const h = setup(t);
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(5000);
  h.controller.handleAppliedPulse(h.attempts[0].correlationId);
  assert.equal(h.snapshot().activeRequest, null);
  assert.equal(h.snapshot().estimate.kind, 'unknown');
  await h.clock.tick(250000);
  assert.equal(h.attempts.length, 1);
});

test('an early runtime timer cannot leave an external movement estimate alive indefinitely', async t => {
  const h = setup(t);
  const schedule = h.clock.setTimeout;
  h.clock.setTimeout = (callback, ms) => schedule(callback, Math.max(0, ms - 0.5));
  h.visiblePulse();
  await h.clock.tick(25001);
  assert.equal(h.snapshot().estimate.kind, 'unknown');
  assert.equal(h.snapshot().activeRequest, null);
  assert.equal(h.attempts.length, 0);
});

test('an uncorrelated edge already accounted for by contact departure cannot be counted as a stop', t => {
  const h = setup(t);
  h.hiddenPulse(); // Contact arrives before its applied-edge observation.
  assert.equal(h.snapshot().estimate.direction, 'opening');
  h.controller.handleAppliedPulse();
  assert.equal(h.snapshot().estimate.kind, 'unknown');
  assert.equal(h.attempts.length, 0);
});

test('an applied edge older than a more recent local attempt invalidates chronology', async t => {
  const h = setup(t, { allowSpeculativeSequences: true });
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(10000);
  await h.controller.requestHomeKitTarget('closed');
  await h.clock.flush();
  await h.clock.tick(100);
  h.controller.handleAppliedPulse(undefined, 9950);
  assert.equal(h.snapshot().estimate.kind, 'unknown');
  assert.equal(h.snapshot().activeRequest, null);
  await h.clock.tick(250000);
  assert.equal(h.attempts.length, 2);
});
