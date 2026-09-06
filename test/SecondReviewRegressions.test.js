// FSM-level admission checks supplement the S1 MQTT/virtual-motor cases in GateAdapters.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/VirtualGate');

function setup(t, unknown = false) {
  const h = harness({ unknownTargetPolicy: 'single_pulse_best_effort' });
  t.after(h.dispose);
  if (unknown) {
    h.controller.handleSensorConnectedChange(false);
    h.controller.handleSensorConnectedChange(true);
    h.controller.handleClosedSensorChange(false);
    h.contacts(false);
  }
  return h;
}

for (const evidence of ['external', 'ambiguous', 'gap', 'applied-edge', 'local-attempt']) {
  test(`S1 FSM: ${evidence} invalidates a captured sample even when its caller bypasses the adapter`, async t => {
    const h = setup(t, true);
    await h.clock.tick(100);
    const olderContact = h.controller.captureContactMetadata();
    await h.clock.tick(100);
    if (evidence === 'external' || evidence === 'ambiguous') h.controller.handleCommandIntent(evidence);
    if (evidence === 'gap') h.controller.handleObservationGap();
    if (evidence === 'applied-edge') h.controller.handleAppliedPulse(undefined, 200);
    if (evidence === 'local-attempt') await h.controller.requestHomeKitTarget('open');
    const attempts = h.attempts.length;
    await h.clock.tick(100);
    assert.equal(h.controller.acceptsContact(olderContact), false);
    assert.equal(h.controller.handleClosedSensorChange(true, olderContact), false);
    assert.equal(h.snapshot().estimate.kind, 'unknown');
    await h.clock.tick(300000);
    assert.equal(h.attempts.length, attempts);
    assert.equal(h.snapshot().activeRequest, null);
  });
}

test('S1 FSM: a timestamped legacy caller cannot restore a sample predating newer motion evidence', async t => {
  const h = setup(t, true);
  await h.clock.tick(100);
  const metadata = { receivedAt: h.clock.now(), epoch: h.snapshot().observationEpoch };
  await h.clock.tick(100);
  h.controller.handleCommandIntent('external');
  await h.clock.tick(100);
  assert.equal(h.controller.handleClosedSensorChange(true, metadata), false);
  assert.equal(h.snapshot().estimate.kind, 'unknown');
});

test('S1 FSM: revisions distinguish same-timestamp receipt order, while an unstamped tie is rejected', async t => {
  const h = setup(t, true);
  await h.clock.tick(100);
  const before = h.controller.captureContactMetadata();
  h.controller.handleCommandIntent('external');
  const after = h.controller.captureContactMetadata();
  assert.equal(before.receivedAt, after.receivedAt);
  assert.equal(h.controller.handleClosedSensorChange(true, before), false);
  assert.equal(h.controller.handleClosedSensorChange(true, { receivedAt: before.receivedAt, epoch: before.epoch }), false);
  assert.equal(h.snapshot().estimate.kind, 'unknown');
  assert.equal(h.controller.handleClosedSensorChange(true, after), true);
  assert.equal(h.snapshot().estimate.kind, 'closed');
});

test('S1 control: creating a waiting first-pulse request does not supersede an unchanged CLOSED sample', async t => {
  const h = setup(t);
  h.controller.handleCommandIntent('external');
  await h.clock.tick(100);
  h.controller.handleClosedSensorChange(true);
  const metadata = h.controller.captureContactMetadata();
  await h.controller.requestHomeKitTarget('open');
  const id = h.snapshot().activeRequest.id;
  await h.clock.tick(100);
  assert.equal(h.controller.handleClosedSensorChange(true, metadata), true);
  assert.equal(h.snapshot().activeRequest.id, id);
  assert.equal(h.attempts.length, 0);
  await h.clock.tick(2800);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].requestId, id);
  assert.equal(h.controller.handleClosedSensorChange(true, metadata), false, 'the later actual attempt supersedes it');
  await h.clock.tick(300000);
  assert.equal(h.attempts.length, 1);
});

test('S1 control: publication completion does not invalidate contact evidence captured after the attempt', async t => {
  const h = setup(t, true);
  h.mode('timeout-delivered');
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(100);
  const metadata = h.controller.captureContactMetadata();
  h.pending[0].resolve();
  await h.clock.flush();
  await h.clock.tick(100);
  assert.equal(h.controller.handleClosedSensorChange(true, metadata), true);
  assert.equal(h.snapshot().estimate.kind, 'closed');
  assert.equal(h.snapshot().activeRequest, null);
  await h.clock.tick(300000);
  assert.equal(h.attempts.length, 1);
});

test('S1 control: an applicable own edge supersedes older evidence, but its duplicate does not supersede a newer sample', async t => {
  const h = setup(t, true);
  await h.controller.requestHomeKitTarget('open');
  await h.clock.tick(100);
  const before = h.controller.captureContactMetadata();
  h.controller.handleAppliedPulse(h.attempts[0].correlationId, 0);
  assert.equal(h.controller.handleClosedSensorChange(true, before), false);
  const after = h.controller.captureContactMetadata();
  h.controller.handleAppliedPulse(h.attempts[0].correlationId, 0);
  assert.equal(h.controller.handleClosedSensorChange(true, after), true);
  assert.equal(h.snapshot().estimate.kind, 'closed');
  assert.equal(h.attempts.length, 1);
});

test('S1 control: an applied edge proven older than a CLOSED anchor does not invalidate a current sample', async t => {
  const h = setup(t);
  await h.clock.tick(200);
  h.controller.handleClosedSensorChange(true);
  const metadata = h.controller.captureContactMetadata();
  await h.clock.tick(10);
  h.controller.handleAppliedPulse(undefined, 10);
  assert.equal(h.controller.handleClosedSensorChange(true, metadata), true);
  assert.equal(h.snapshot().estimate.kind, 'closed');
  assert.equal(h.attempts.length, 0);
});
