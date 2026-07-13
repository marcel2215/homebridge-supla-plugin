'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FrontGateError,
  FrontGateFsm,
} = require('../dist/Accesories/FrontGateFsm.js');

const CURRENT = {
  OPEN: 0,
  CLOSED: 1,
  OPENING: 2,
  CLOSING: 3,
  STOPPED: 4,
};

const TARGET = {
  OPEN: 0,
  CLOSED: 1,
};

class ManualScheduler {
  constructor() {
    this.currentTime = 10000;
    this.nextId = 0;
    this.tasks = new Map();
  }

  now() {
    return this.currentTime;
  }

  schedule(callback, delayMs) {
    const id = ++this.nextId;
    this.tasks.set(id, {
      at: this.currentTime + Math.max(0, delayMs),
      callback,
    });
    return () => this.tasks.delete(id);
  }

  async advanceBy(delayMs, fsm) {
    const targetTime = this.currentTime + delayMs;
    while (true) {
      const next = Array.from(this.tasks.entries())
        .filter(([, task]) => task.at <= targetTime)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) {
        break;
      }
      const [id, task] = next;
      this.tasks.delete(id);
      this.currentTime = task.at;
      task.callback();
      await fsm.whenIdle();
    }
    this.currentTime = targetTime;
    await fsm.whenIdle();
  }
}

function createHarness(config = {}) {
  const scheduler = new ManualScheduler();
  const attempts = [];
  const successfulPulses = [];
  const failedAttemptNumbers = new Set();
  const snapshots = [];
  const logs = [];
  const io = {
    pulseMotor: async reason => {
      attempts.push(reason);
      if (failedAttemptNumbers.has(attempts.length)) {
        throw new Error(`pulse ${attempts.length} failed`);
      }
      successfulPulses.push(reason);
    },
    publishSnapshot: snapshot => snapshots.push(snapshot),
    log: {
      debug: message => logs.push(['debug', message]),
      info: message => logs.push(['info', message]),
      warn: message => logs.push(['warn', message]),
    },
  };
  const fsm = new FrontGateFsm(io, {
    fullTravelMs: 100,
    reversePauseMs: 20,
    minimumPulseGapMs: 0,
    unknownOpenPolicy: 'reject',
    unknownClosePolicy: 'reject',
    seekClosedMaxPulses: 3,
    assumeOpenAfterTravel: false,
    ...config,
  }, scheduler);

  return {
    attempts,
    failedAttemptNumbers,
    fsm,
    logs,
    scheduler,
    snapshots,
    successfulPulses,
  };
}

async function establishOnlineState(fsm, closed, sampleFirst = true) {
  fsm.handleTransportConnectedChange(true);
  if (sampleFirst) {
    fsm.handleClosedSensorChange(closed);
  }
  fsm.handleSensorConnectedChange(true);
  fsm.handleControlConnectedChange(true);
  if (!sampleFirst) {
    fsm.handleClosedSensorChange(closed);
  }
  await fsm.whenIdle();
}

test('a false closed sensor baseline is STOPPED and strict requests are rejected', async () => {
  const harness = createHarness();
  await establishOnlineState(harness.fsm, false);

  const snapshot = harness.fsm.getSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.currentDoorState, CURRENT.STOPPED);
  assert.equal(snapshot.targetDoorState, TARGET.OPEN);

  await assert.rejects(
    harness.fsm.requestHomeKitTarget('open'),
    error => error instanceof FrontGateError && error.code === 'not_allowed',
  );
  await assert.rejects(
    harness.fsm.requestHomeKitTarget('closed'),
    error => error instanceof FrontGateError && error.code === 'not_allowed',
  );
  assert.equal(harness.attempts.length, 0);
});

test('retained sensor state can arrive before connected states without blocking availability', async () => {
  const harness = createHarness();
  await establishOnlineState(harness.fsm, false, true);

  const snapshot = harness.fsm.getSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.sensorSampleEpoch, snapshot.observationEpoch);
  assert.equal(snapshot.currentDoorState, CURRENT.STOPPED);
});

test('the first sensor sample after transport loss is a baseline, not a false opening edge', async () => {
  const harness = createHarness();
  await establishOnlineState(harness.fsm, true);

  harness.fsm.handleTransportConnectedChange(false);
  harness.fsm.handleTransportConnectedChange(true);
  harness.fsm.handleClosedSensorChange(false);
  harness.fsm.handleSensorConnectedChange(true);
  harness.fsm.handleControlConnectedChange(true);
  await harness.fsm.whenIdle();

  const snapshot = harness.fsm.getSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.positionEstimate, 'notClosedUnknown');
  assert.equal(snapshot.currentDoorState, CURRENT.STOPPED);
});

test('an opening timeout becomes unknown by default and OPEN only in opt-in mode', async () => {
  const strict = createHarness();
  await establishOnlineState(strict.fsm, true);
  await strict.fsm.requestHomeKitTarget('open');
  strict.fsm.handleClosedSensorChange(false);
  await strict.fsm.whenIdle();
  await strict.scheduler.advanceBy(100, strict.fsm);
  assert.equal(strict.fsm.getSnapshot().currentDoorState, CURRENT.STOPPED);
  assert.equal(strict.fsm.getSnapshot().positionEstimate, 'notClosedUnknown');

  const approximate = createHarness({ assumeOpenAfterTravel: true });
  await establishOnlineState(approximate.fsm, true);
  await approximate.fsm.requestHomeKitTarget('open');
  approximate.fsm.handleClosedSensorChange(false);
  await approximate.fsm.whenIdle();
  await approximate.scheduler.advanceBy(100, approximate.fsm);
  assert.equal(approximate.fsm.getSnapshot().currentDoorState, CURRENT.OPEN);
  assert.equal(approximate.fsm.getSnapshot().positionEstimate, 'openAssumed');
});

test('reversal pause reports STOPPED and only reports motion after the second pulse', async () => {
  const harness = createHarness();
  await establishOnlineState(harness.fsm, true);
  await harness.fsm.requestHomeKitTarget('open');
  harness.fsm.handleClosedSensorChange(false);
  await harness.fsm.whenIdle();

  await harness.fsm.requestHomeKitTarget('closed');
  let snapshot = harness.fsm.getSnapshot();
  assert.equal(harness.successfulPulses.length, 2);
  assert.equal(snapshot.operationKind, 'reversalPause');
  assert.equal(snapshot.currentDoorState, CURRENT.STOPPED);
  assert.equal(snapshot.targetDoorState, TARGET.CLOSED);

  await harness.scheduler.advanceBy(20, harness.fsm);
  snapshot = harness.fsm.getSnapshot();
  assert.equal(harness.successfulPulses.length, 3);
  assert.equal(snapshot.operationKind, 'none');
  assert.equal(snapshot.currentDoorState, CURRENT.CLOSING);
});

test('a failed reversal pulse leaves the gate STOPPED and clears the operation', async () => {
  const harness = createHarness();
  harness.failedAttemptNumbers.add(3);
  await establishOnlineState(harness.fsm, true);
  await harness.fsm.requestHomeKitTarget('open');
  harness.fsm.handleClosedSensorChange(false);
  await harness.fsm.whenIdle();
  await harness.fsm.requestHomeKitTarget('closed');

  await harness.scheduler.advanceBy(20, harness.fsm);
  const snapshot = harness.fsm.getSnapshot();
  assert.equal(snapshot.operationKind, 'none');
  assert.equal(snapshot.positionEstimate, 'notClosedUnknown');
  assert.equal(snapshot.currentDoorState, CURRENT.STOPPED);
  assert.equal(snapshot.targetDoorState, TARGET.CLOSED);
});

test('a first-pulse failure rolls back target intent', async () => {
  const harness = createHarness();
  harness.failedAttemptNumbers.add(1);
  await establishOnlineState(harness.fsm, true);

  await assert.rejects(
    harness.fsm.requestHomeKitTarget('open'),
    error => error instanceof FrontGateError && error.code === 'communication_failure',
  );
  const snapshot = harness.fsm.getSnapshot();
  assert.equal(snapshot.desiredTarget, null);
  assert.equal(snapshot.currentDoorState, CURRENT.CLOSED);
  assert.equal(snapshot.targetDoorState, TARGET.CLOSED);
});

test('a delayed pulse is cancelled by external activity and never fires stale', async () => {
  const harness = createHarness({ minimumPulseGapMs: 100 });
  await establishOnlineState(harness.fsm, true);
  await harness.fsm.requestHomeKitTarget('open');
  harness.fsm.handleClosedSensorChange(false);
  await harness.fsm.whenIdle();

  await harness.fsm.requestHomeKitTarget('closed');
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.fsm.getSnapshot().operationKind, 'scheduledPulse');

  harness.fsm.handleObservedExternalPulse('test-external-command');
  await harness.fsm.whenIdle();
  await harness.scheduler.advanceBy(100, harness.fsm);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.fsm.getSnapshot().currentDoorState, CURRENT.STOPPED);
});

test('a conflicting HomeKit target cancels a delayed pulse', async () => {
  const harness = createHarness({ fullTravelMs: 200, minimumPulseGapMs: 100 });
  await establishOnlineState(harness.fsm, true);
  await harness.fsm.requestHomeKitTarget('open');
  harness.fsm.handleClosedSensorChange(false);
  await harness.fsm.whenIdle();
  await harness.fsm.requestHomeKitTarget('closed');

  await harness.fsm.requestHomeKitTarget('open');
  await harness.scheduler.advanceBy(100, harness.fsm);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.fsm.getSnapshot().currentDoorState, CURRENT.OPENING);
  assert.equal(harness.fsm.getSnapshot().targetDoorState, TARGET.OPEN);
});

test('transport loss cancels a delayed pulse and invalidates availability', async () => {
  const harness = createHarness({ minimumPulseGapMs: 100 });
  await establishOnlineState(harness.fsm, true);
  await harness.fsm.requestHomeKitTarget('open');
  harness.fsm.handleClosedSensorChange(false);
  await harness.fsm.whenIdle();
  await harness.fsm.requestHomeKitTarget('closed');

  harness.fsm.handleTransportConnectedChange(false);
  await harness.fsm.whenIdle();
  await harness.scheduler.advanceBy(100, harness.fsm);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.fsm.getSnapshot().available, false);
  assert.equal(harness.fsm.getSnapshot().operationKind, 'none');
});

test('a delayed stop-pulse failure has an explicit STOPPED transition', async () => {
  const harness = createHarness({ fullTravelMs: 200, minimumPulseGapMs: 100 });
  harness.failedAttemptNumbers.add(2);
  await establishOnlineState(harness.fsm, true);
  await harness.fsm.requestHomeKitTarget('open');
  harness.fsm.handleClosedSensorChange(false);
  await harness.fsm.whenIdle();
  await harness.fsm.requestHomeKitTarget('closed');

  await harness.scheduler.advanceBy(100, harness.fsm);
  const snapshot = harness.fsm.getSnapshot();
  assert.equal(snapshot.operationKind, 'none');
  assert.equal(snapshot.positionEstimate, 'notClosedUnknown');
  assert.equal(snapshot.currentDoorState, CURRENT.STOPPED);
  assert.equal(snapshot.targetDoorState, TARGET.CLOSED);
});

test('new sensor evidence cancels a pending reversal pulse', async () => {
  const harness = createHarness();
  await establishOnlineState(harness.fsm, true);
  await harness.fsm.requestHomeKitTarget('open');
  harness.fsm.handleClosedSensorChange(false);
  await harness.fsm.whenIdle();
  await harness.fsm.requestHomeKitTarget('closed');

  harness.fsm.handleClosedSensorChange(true);
  await harness.fsm.whenIdle();
  await harness.scheduler.advanceBy(20, harness.fsm);
  assert.equal(harness.attempts.length, 2);
  assert.equal(harness.fsm.getSnapshot().currentDoorState, CURRENT.CLOSED);
  assert.equal(harness.fsm.getSnapshot().operationKind, 'none');
});

test('dispose cancels pending pulses', async () => {
  const harness = createHarness({ minimumPulseGapMs: 100 });
  await establishOnlineState(harness.fsm, true);
  await harness.fsm.requestHomeKitTarget('open');
  harness.fsm.handleClosedSensorChange(false);
  await harness.fsm.whenIdle();
  await harness.fsm.requestHomeKitTarget('closed');

  harness.fsm.dispose();
  await harness.scheduler.advanceBy(100, harness.fsm);
  assert.equal(harness.attempts.length, 1);
});

test('seek_closed is bounded, remains STOPPED, and stops when the sensor closes', async () => {
  const harness = createHarness({ unknownClosePolicy: 'seek_closed' });
  await establishOnlineState(harness.fsm, false);
  await harness.fsm.requestHomeKitTarget('closed');

  let snapshot = harness.fsm.getSnapshot();
  assert.equal(harness.successfulPulses.length, 1);
  assert.equal(snapshot.operationKind, 'seekClosed');
  assert.equal(snapshot.currentDoorState, CURRENT.STOPPED);

  await harness.scheduler.advanceBy(100, harness.fsm);
  assert.equal(harness.successfulPulses.length, 2);
  harness.fsm.handleClosedSensorChange(true);
  await harness.fsm.whenIdle();
  await harness.scheduler.advanceBy(200, harness.fsm);

  snapshot = harness.fsm.getSnapshot();
  assert.equal(harness.successfulPulses.length, 2);
  assert.equal(snapshot.operationKind, 'none');
  assert.equal(snapshot.currentDoorState, CURRENT.CLOSED);
  assert.equal(snapshot.targetDoorState, TARGET.CLOSED);
});

test('seek_closed sends no more than the configured maximum', async () => {
  const harness = createHarness({
    unknownClosePolicy: 'seek_closed',
    seekClosedMaxPulses: 3,
  });
  await establishOnlineState(harness.fsm, false);
  await harness.fsm.requestHomeKitTarget('closed');
  await harness.scheduler.advanceBy(300, harness.fsm);

  const snapshot = harness.fsm.getSnapshot();
  assert.equal(harness.successfulPulses.length, 3);
  assert.equal(snapshot.operationKind, 'none');
  assert.equal(snapshot.currentDoorState, CURRENT.STOPPED);
  assert.equal(snapshot.targetDoorState, TARGET.CLOSED);
});

test('repeating an accepted target does not publish another pulse', async () => {
  const harness = createHarness();
  await establishOnlineState(harness.fsm, true);
  await harness.fsm.requestHomeKitTarget('open');
  await harness.fsm.requestHomeKitTarget('open');
  assert.equal(harness.successfulPulses.length, 1);
});

test('a best-effort close is never blindly repeated while its result is unknown', async () => {
  const harness = createHarness({ unknownClosePolicy: 'single_pulse_best_effort' });
  await establishOnlineState(harness.fsm, false);
  await harness.fsm.requestHomeKitTarget('closed');

  await assert.rejects(
    harness.fsm.requestHomeKitTarget('closed'),
    error => error instanceof FrontGateError && error.code === 'not_allowed',
  );
  assert.equal(harness.successfulPulses.length, 1);
  assert.equal(harness.fsm.getSnapshot().currentDoorState, CURRENT.STOPPED);
});
