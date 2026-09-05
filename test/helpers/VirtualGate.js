const assert = require('node:assert/strict');
const { FrontGateFsm, GateNotSentError } = require('../../dist/Accesories/FrontGateFsm');

class FakeClock {
  time = 0;
  nextId = 0;
  timers = new Map();
  hooks = new Set();
  now = () => this.time;
  setTimeout = (callback, ms) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  async flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  async tick(ms) {
    const end = this.time + ms;
    for (let count = 0; ; count++) {
      assert.ok(count < 10000, 'timer loop must remain bounded');
      await this.flush();
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      // Physical endpoint/contact effects precede controller deadline callbacks at the same instant.
      for (const hook of this.hooks) hook(this.time);
      if (this.timers.delete(next[0])) next[1].callback();
    }
    this.time = end;
    for (const hook of this.hooks) hook(this.time);
    await this.flush();
  }
}

// Independent motor model. It neither imports estimator code nor reads any controller state.
class VirtualGate {
  position = 0;
  motion = 'none';
  nextDirection = 'opening';
  relayUntil = -Infinity;
  edges = 0;
  lastAt = 0;
  endpointTimer;
  lastClosed = true;
  constructor(clock, contact, { openingMs = 25000, closingMs = 25000, relayHighMs = 0 } = {}) {
    this.clock = clock;
    this.contact = contact;
    this.openingMs = openingMs;
    this.closingMs = closingMs;
    this.relayHighMs = relayHighMs;
    clock.hooks.add(() => this.integrate());
  }
  integrate() {
    const elapsed = this.clock.now() - this.lastAt;
    this.lastAt = this.clock.now();
    if (this.motion === 'opening') this.position += elapsed / this.openingMs;
    if (this.motion === 'closing') this.position -= elapsed / this.closingMs;
    if (this.position >= 1 - 1e-12 && this.motion === 'opening') {
      this.position = 1;
      this.motion = 'none';
      this.nextDirection = 'closing';
    }
    if (this.position <= 1e-12 && this.motion === 'closing') {
      this.position = 0;
      this.motion = 'none';
      this.nextDirection = 'opening';
    }
    const closed = this.position === 0 && this.motion !== 'opening';
    if (closed !== this.lastClosed) {
      this.lastClosed = closed;
      this.contact(closed);
    }
  }
  pulse() {
    this.integrate();
    if (this.clock.now() < this.relayUntil) {
      this.relayUntil = this.clock.now() + this.relayHighMs;
      return false;
    }
    this.relayUntil = this.clock.now() + this.relayHighMs;
    this.edges++;
    this.clock.clearTimeout(this.endpointTimer);
    if (this.motion !== 'none') {
      this.nextDirection = this.motion === 'opening' ? 'closing' : 'opening';
      this.motion = 'none';
    } else {
      this.motion = this.position === 0 ? 'opening' : this.position === 1 ? 'closing' : this.nextDirection;
      const remaining = this.motion === 'opening' ? (1 - this.position) * this.openingMs : this.position * this.closingMs;
      this.endpointTimer = this.clock.setTimeout(() => this.integrate(), remaining);
    }
    this.integrate();
    return true;
  }
  get state() {
    return this.motion !== 'none' ? this.motion : this.position === 0 ? 'closed' : this.position === 1 ? 'open' : 'stopped';
  }
}

function harness(options = {}, plantOptions = {}) {
  const clock = new FakeClock();
  const attempts = [];
  const snapshots = [];
  const logs = [];
  const terminals = new Map();
  const pending = [];
  let nextMode = 'success';
  let controller;
  let deliverContact = true;
  const plant = new VirtualGate(clock, closed => {
    if (deliverContact) controller?.handleClosedSensorChange(closed);
  }, plantOptions);
  const check = snapshot => {
    snapshots.push(snapshot);
    if (snapshot.activeRequest) {
      assert.ok(snapshot.activeRequest.attempts <= snapshot.activeRequest.pulseBudget);
    }
    if (snapshot.lastResult && !terminals.has(snapshot.lastResult.id)) {
      const result = snapshot.lastResult;
      terminals.set(result.id, attempts.filter(attempt => attempt.requestId === result.id).length);
      assert.ok(result.attempts <= result.pulseBudget);
    }
    for (const [id, count] of terminals) {
      assert.equal(attempts.filter(attempt => attempt.requestId === id).length, count, `terminal request ${id} cannot actuate again`);
    }
  };
  controller = new FrontGateFsm({
    pulseMotor: (reason, effect) => {
      assert.ok(!terminals.has(effect.requestId), 'no publication after request termination');
      attempts.push({ ...effect, at: clock.now(), reason });
      const mode = nextMode;
      nextMode = 'success';
      if (mode === 'not-sent') return Promise.reject(new GateNotSentError('offline before write'));
      if (!['timeout-not-delivered', 'error-not-delivered'].includes(mode)) plant.pulse();
      if (mode.startsWith('error')) return Promise.reject(new Error('ambiguous publication'));
      if (mode.startsWith('timeout')) return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      return Promise.resolve();
    },
    publishSnapshot: check,
    log: Object.fromEntries(['debug', 'info', 'warn'].map(level => [level, message => logs.push({ level, message })])),
  }, { travelUncertainty: 0, actuationDelayMs: 0, sensorDebounceMs: 0, sensorDelayMs: 0, ...options }, clock);
  controller.handleTransportConnectedChange(true);
  controller.handleControlConnectedChange(true);
  controller.handleSensorConnectedChange(true);
  controller.handleClosedSensorChange(true);
  return {
    clock, plant, controller, attempts, snapshots, logs, terminals, pending,
    snapshot: () => controller.getSnapshot(),
    mode: value => { nextMode = value; },
    contacts: value => { deliverContact = value; },
    visiblePulse: () => { controller.handleAppliedPulse(); plant.pulse(); },
    hiddenPulse: () => plant.pulse(),
    check: () => check(controller.getSnapshot()),
    dispose: () => controller.dispose(),
  };
}
module.exports = { FakeClock, VirtualGate, harness };
