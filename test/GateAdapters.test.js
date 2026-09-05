const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const mqtt = require('mqtt');
const hap = require(process.env.SUPLA_TEST_HAP_PATH || '@homebridge/hap-nodejs');
const { GateMqttTransport } = require('../dist/Heplers/GateMqttTransport');
const { GateAccessory, parseGateBoolean } = require('../dist/Accesories/GateAccessory');
const { NativeGateObserver } = require('../dist/Accesories/GateObservationSource');
const { resolveFrontGateConfig, normalizeFrontGateTimings } = require('../dist/Accesories/FrontGateConfig');
const { gateClock } = require('../dist/Accesories/FrontGateFsm');
const { FakeClock } = require('./helpers/VirtualGate');

const log = { debug() {}, info() {}, warn() {}, error() {} };
const base = 'supla/test/devices/10/channels/20';
const sensorBase = 'supla/test/devices/10/channels/21';
const control = { deviceId: '10', channelId: '20', topic: base, channelFunction: 'CONTROLLINGTHEGATE', channelCaption: 'Gate' };
const otherControl = { ...control, channelId: '22', topic: 'supla/test/devices/10/channels/22' };
const mapping = { deviceId: '10', channelId: '20', sensorDeviceId: '10', sensorChannelId: '21' };

class MockMqtt extends EventEmitter {
  connected = true;
  publications = [];
  subscriptions = [];
  unsubscribed = [];
  delayed = false;
  denied = new Set();
  callbacks = [];
  onPublish = (_topic, _payload, callback) => callback();
  constructor(version = 5) { super(); this.options = { protocolVersion: version }; }
  subscribe(topic, options, callback) {
    this.subscriptions.push({ topic, options });
    const complete = () => callback(undefined, [{ topic, qos: this.denied.has(topic) ? 128 : 0 }]);
    if (this.delayed) this.callbacks.push(complete); else complete();
  }
  unsubscribe(topic) { this.unsubscribed.push(topic); }
  publish(topic, payload, options, callback) {
    this.publications.push({ topic, payload, options });
    this.onPublish(topic, payload, callback);
  }
  message(topic, value, packet = {}) {
    this.emit('message', topic, Buffer.from(String(value)), { topic, retain: false, qos: 0, dup: false, ...packet });
  }
  disconnect() { this.connected = false; this.emit('close'); }
  reconnect() { this.connected = true; this.emit('connect'); }
  end() { this.disconnect(); }
}

function transportHarness(t, version = 5) {
  const client = new MockMqtt(version);
  const transport = new GateMqttTransport(client, log);
  t.after(() => transport.dispose());
  const health = [];
  const messages = [];
  const register = () => transport.register('owner', base, sensorBase, undefined,
    (...args) => messages.push(args), (...args) => health.push(args));
  return { client, transport, register, health, messages };
}

function accessoryHarness(t, { version = 5, options = {}, validMapping = true, delayed = false } = {}) {
  const client = new MockMqtt(version);
  client.delayed = delayed;
  const transport = new GateMqttTransport(client, log);
  const accessory = new hap.Accessory('Front gate', hap.uuid.generate('front-gate-test'));
  accessory.context = { frontGateFsm: { oldDirection: 'opening' } };
  const originalService = accessory.addService(hap.Service.GarageDoorOpener);
  const cleanups = [];
  const config = validMapping ? { frontGates: [{ ...mapping, sensorDebounceMs: 0, ...options }] } : {};
  const platform = {
    config, log, api: { hap }, Service: hap.Service, Characteristic: hap.Characteristic,
    normalizeTopicBase: topic => topic.replace(/\/+$/, ''),
    getFrontGateConfig: context => resolveFrontGateConfig(config, context, [control], log.warn),
    getGateMqttTransport: () => transport,
    registerOwnerCleanup: (_owner, callback) => cleanups.push(callback),
  };
  const adapter = new GateAccessory(platform, accessory, control);
  t.after(() => { cleanups.forEach(callback => callback()); transport.dispose(); });
  const contact = (closed, packet) => client.message(`${sensorBase}/state/hi`, closed, packet);
  const online = (contactFirst = false) => {
    if (contactFirst) contact(true, { retain: true });
    client.message(`${base}/state/connected`, true, { retain: true });
    client.message(`${sensorBase}/state/connected`, true, { retain: true });
    if (!contactFirst) contact(true, { retain: true });
  };
  return {
    client, transport, accessory, adapter, originalService, contact, online, cleanups,
    target: originalService.getCharacteristic(hap.Characteristic.TargetDoorState),
    current: originalService.getCharacteristic(hap.Characteristic.CurrentDoorState),
  };
}
const immediate = () => new Promise(resolve => setImmediate(resolve));

function fakeAccessoryClock(t) {
  const clock = new FakeClock();
  t.mock.method(gateClock, 'now', clock.now);
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => ({
    id: clock.setTimeout(() => callback(...args), ms), unref() { return this; },
  }));
  t.mock.method(global, 'clearTimeout', timer => clock.clearTimeout(timer?.id ?? timer));
  return clock;
}

test('R3: ignored retained contact cannot bypass debounce and authorize OPEN on a brief spike', async t => {
  const clock = fakeAccessoryClock(t);
  const h = accessoryHarness(t, { options: { sensorDebounceMs: 200 } });
  h.online();
  h.contact(false);
  await clock.tick(200);
  assert.equal(h.adapter.fsm.getSnapshot().closedSensor, false);
  h.contact(true, { retain: true });
  await clock.tick(200);
  assert.equal(h.adapter.fsm.getSnapshot().closedSensor, false);
  h.contact(true);
  const duringSpike = h.adapter.fsm.getSnapshot();
  const accepted = await h.target.handleSetRequest(0).then(() => true, () => false);
  await clock.tick(20);
  h.contact(false);
  await clock.tick(200);
  assert.equal(h.client.publications.length, 0);
  assert.equal(accepted, false);
  assert.notEqual(duringSpike.estimate.kind, 'closed');
  assert.notEqual(h.adapter.fsm.getSnapshot().estimate.kind, 'closed');
});

for (const retainedValue of [false, true, 'garbage']) {
  test(`R3: ignored retained ${retainedValue} leaves an existing live debounce intact`, async t => {
    const clock = fakeAccessoryClock(t);
    const h = accessoryHarness(t, { options: { sensorDebounceMs: 200 } });
    h.online();
    h.contact(false);
    await clock.tick(200);
    h.contact(true);
    await clock.tick(100);
    h.contact(retainedValue, { retain: true });
    await clock.tick(99);
    await assert.rejects(h.target.handleSetRequest(0));
    assert.equal(h.client.publications.length, 0);
    await clock.tick(1);
    assert.equal(h.adapter.fsm.getSnapshot().estimate.kind, 'closed');
    await h.target.handleSetRequest(0);
    assert.equal(h.client.publications.length, 1);
  });
}

for (const offline of ['sensor', 'transport']) {
  test(`R3: contact packets during ${offline} loss cannot pre-seed the next live debounce`, async t => {
    const clock = fakeAccessoryClock(t);
    const h = accessoryHarness(t, { options: { sensorDebounceMs: 200 } });
    h.online();
    h.contact(false);
    await clock.tick(200);
    if (offline === 'sensor') h.client.message(`${sensorBase}/state/connected`, false);
    else h.client.disconnect();
    h.contact(true);
    await clock.tick(200);
    assert.equal(h.adapter.fsm.getSnapshot().closedSensor, null);
    if (offline === 'transport') h.client.reconnect();
    h.client.message(`${base}/state/connected`, true);
    h.client.message(`${sensorBase}/state/connected`, true);
    h.contact(true);
    await assert.rejects(h.target.handleSetRequest(0));
    assert.equal(h.client.publications.length, 0);
    await clock.tick(200);
    assert.equal(h.adapter.fsm.getSnapshot().estimate.kind, 'closed');
  });
}

test('R3: a debounce callback from an obsolete observation epoch cannot commit or poison the baseline', async t => {
  const clock = fakeAccessoryClock(t);
  const h = accessoryHarness(t, { options: { sensorDebounceMs: 200 } });
  h.online();
  h.contact(false);
  await clock.tick(200);
  h.contact(true);
  h.adapter.fsm.handleInvalidContact(); // Invalidate the epoch while the adapter still has a delayed sample.
  await clock.tick(200);
  assert.equal(h.adapter.fsm.getSnapshot().closedSensor, null);
  h.contact(true);
  await assert.rejects(h.target.handleSetRequest(0));
  await clock.tick(200);
  assert.equal(h.adapter.fsm.getSnapshot().estimate.kind, 'closed');
  assert.equal(h.client.publications.length, 0);
});

test('R3: sustained live closure ends an already attempted OPEN without any later reopening', async t => {
  const clock = fakeAccessoryClock(t);
  const h = accessoryHarness(t, { options: { sensorDebounceMs: 200 } });
  h.online();
  await clock.tick(200);
  await h.target.handleSetRequest(0);
  h.contact(false);
  await clock.tick(200);
  h.contact(true);
  await clock.tick(200);
  assert.equal(h.adapter.fsm.getSnapshot().lastResult.reason, 'target-mismatch-closed');
  await immediate();
  assert.equal(h.current.value, hap.Characteristic.CurrentDoorState.CLOSED);
  assert.equal(h.target.value, hap.Characteristic.TargetDoorState.CLOSED);
  await clock.tick(250000);
  assert.equal(h.client.publications.length, 1);
});

test('R2: the real HAP rejection/reporting sequence keeps a closing estimate targeting CLOSED', async t => {
  const clock = fakeAccessoryClock(t);
  const h = accessoryHarness(t, { options: { assumeOpenAfterTravel: true } });
  h.online();
  await h.target.handleSetRequest(0);
  h.contact(false);
  await clock.tick(31000);
  assert.equal(h.current.value, hap.Characteristic.CurrentDoorState.OPEN);
  await h.target.handleSetRequest(1);
  await clock.tick(1000);
  await assert.rejects(h.target.handleSetRequest(0));
  await immediate();
  assert.equal(h.current.value, hap.Characteristic.CurrentDoorState.CLOSING);
  assert.equal(h.target.value, hap.Characteristic.TargetDoorState.CLOSED);
  assert.equal(await h.target.handleGetRequest(), hap.Characteristic.TargetDoorState.CLOSED);
  assert.equal(h.adapter.fsm.getSnapshot().activeRequest, null);
  await clock.tick(250000);
  assert.equal(h.client.publications.length, 2);
});

for (const version of [4, 5]) {
  test(`MQTT ${version} gate publications remain open_close, QoS 0, non-retained`, async t => {
    const h = transportHarness(t, version);
    h.register();
    await h.transport.publish('owner');
    assert.deepEqual(h.client.publications, [{ topic: `${base}/execute_action`, payload: 'open_close', options: { qos: 0, retain: false } }]);
    assert.ok(h.client.subscriptions.every(item => !/[+#]/.test(item.topic)));
    assert.ok(h.client.subscriptions.every(item => version === 5 ? item.options.nl === true : item.options.nl === undefined));
  });
}

test('gate client disables QoS 0 buffering and uses a clean session; ordinary client options are preserved', () => {
  const file = path.resolve('dist/Heplers/SuplaMqttClient.js');
  const options = [];
  const fakeMqtt = { connect(_url, settings) { options.push(settings); return new MockMqtt(); } };
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, require: name => name === 'mqtt' ? fakeMqtt : nativeRequire(name),
    Buffer, setTimeout, clearTimeout,
  }, { filename: file });
  const Client = module.exports.SuplaMqttClient;
  const context = { host: 'unused.invalid', port: 1883, username: 'test', password: 'test' };
  new Client(context, log, { gateActuation: true, protocolVersion: 5 });
  new Client(context, log);
  assert.equal(options[0].queueQoSZero, false);
  assert.equal(options[0].clean, true);
  assert.equal(options[0].resubscribe, false);
  assert.equal(options[0].protocolVersion, 5);
  assert.equal(options[1].queueQoSZero, undefined);
});

test('real MQTT.js rejects offline QoS 0 publications without putting them into its queue', async () => {
  const client = new mqtt.MqttClient(() => { throw new Error('test must not open a socket'); }, {
    manualConnect: true, queueQoSZero: false, clean: true, resubscribe: false, reconnectPeriod: 0,
  });
  try {
    await assert.rejects(new Promise((resolve, reject) => {
      client.publish(`${base}/execute_action`, 'open_close', { qos: 0, retain: false }, error => error ? reject(error) : resolve());
    }));
    assert.equal(client.queue.length, 0);
  } finally {
    // manualConnect deliberately created no stream; supply an inert stream for MQTT.js cleanup.
    client.stream = new (require('node:stream').PassThrough)();
    client.end(true);
  }
});

test('disconnect immediately disables actuation; reconnect does not replay commands', async t => {
  const h = transportHarness(t);
  h.register();
  await h.transport.publish('owner');
  h.client.disconnect();
  assert.equal(h.health.at(-1)[0], false);
  await assert.rejects(h.transport.publish('owner'), /unavailable/);
  h.client.reconnect();
  assert.equal(h.health.at(-1)[0], true);
  assert.equal(h.client.publications.length, 1);
});

test('denial of just the action subscription disables the whole gate', async t => {
  const h = transportHarness(t);
  h.client.denied.add(`${base}/execute_action`);
  h.register();
  assert.equal(h.health.at(-1)[0], false);
  await assert.rejects(h.transport.publish('owner'));
  assert.equal(h.client.publications.length, 0);
  h.client.denied.clear();
  h.client.reconnect();
  assert.equal(h.health.at(-1)[0], true);
  assert.equal(h.client.publications.length, 0, 'subscription recovery is read-only');
});

test('late SUBACK from a disconnected epoch cannot restore health', t => {
  const h = transportHarness(t);
  h.client.delayed = true;
  h.register();
  const old = h.client.callbacks.splice(0);
  h.client.disconnect();
  h.client.reconnect();
  old.forEach(callback => callback());
  assert.equal(h.health.at(-1)[0], false);
  h.client.callbacks.splice(0).forEach(callback => callback());
  assert.equal(h.health.at(-1)[0], true);
});

test('subscription cleanup keeps other gates intact and prevents commands after disposal', async t => {
  const h = transportHarness(t);
  const unregister = h.register();
  h.transport.register('other', otherControl.topic, sensorBase, undefined, () => {}, () => {});
  unregister();
  assert.ok(!h.client.unsubscribed.includes(`${sensorBase}/state/hi`));
  await assert.rejects(h.transport.publish('owner'));
  await h.transport.publish('other');
  h.transport.dispose();
  await assert.rejects(h.transport.publish('other'));
});

test('exact per-gate contact mapping is independent of discovery order and captions', () => {
  const second = { deviceId: '10', channelId: '22', sensorDeviceId: '11', sensorChannelId: '24' };
  const config = { frontGates: [mapping, second] };
  for (const channels of [[control, otherControl], [otherControl, control], []]) {
    assert.equal(resolveFrontGateConfig(config, control, channels, log.warn).sensorBaseTopic, sensorBase);
    assert.equal(resolveFrontGateConfig(config, otherControl, channels, log.warn).sensorBaseTopic, 'supla/test/devices/11/channels/24');
  }
});

test('fuzzy-only, duplicate, invalid and motor-projection sensor mappings fail closed', () => {
  const cases = [
    {},
    { frontGates: [mapping, mapping] },
    { frontGates: [{ ...mapping, sensorDeviceId: '../11' }] },
    { frontGates: [{ ...mapping, sensorChannelId: '20' }] },
    { frontGates: [{ deviceId: '10', channelId: '20', sensorTopic: 'supla/test/+/state/hi' }] },
    { frontGates: [{ ...mapping, sensorTopic: sensorBase }] },
  ];
  for (const config of cases) assert.ok(resolveFrontGateConfig(config, control, [control], log.warn).error);
});

test('a legacy global contact is allowed only for a single proven gate', () => {
  const config = { frontGateSensorDeviceId: 10, frontGateSensorChannelId: 21 };
  assert.equal(resolveFrontGateConfig(config, control, [control], log.warn).sensorBaseTopic, sensorBase);
  assert.ok(resolveFrontGateConfig(config, control, [control, otherControl], log.warn).error);
  assert.ok(resolveFrontGateConfig(config, control, [], log.warn).error);
});

test('seek_closed and all removed retry settings migrate to rejection with a warning', () => {
  for (const raw of [
    { unknownTargetPolicy: 'seek_closed', seekClosedMaxPulses: 3 },
    { unknownClosePolicy: 'seek_closed', unknownTargetPolicy: 'single_pulse_best_effort' },
    { closeRetryLimit: 3 },
  ]) {
    const warnings = [];
    const config = normalizeFrontGateTimings(raw, message => warnings.push(message));
    assert.equal(config.unknownTargetPolicy, 'reject');
    assert.ok(warnings.length);
    assert.equal(config.seekClosedMaxPulses, undefined);
    assert.equal(config.closeRetryLimit, undefined);
  }
  const warnings = [];
  const resolved = resolveFrontGateConfig({ frontGates: [{ ...mapping, unknownTargetPolicy: 'seek_closed' }] }, control, [], x => warnings.push(x));
  assert.equal(resolved.timings.unknownTargetPolicy, 'reject');
  assert.ok(warnings.length);
});

test('gate booleans reject malformed state instead of turning it into false', () => {
  for (const value of ['true', '1', ' ON ', 'yes']) assert.equal(parseGateBoolean(value), true);
  for (const value of ['false', '0', ' OFF ', 'no']) assert.equal(parseGateBoolean(value), false);
  for (const value of ['', 'null', '2', '{}', 'disconnected']) assert.equal(parseGateBoolean(value), undefined);
});

test('HomeKit identity is preserved and GET/reporting never invoke the actuator SET handler', async t => {
  const h = accessoryHarness(t);
  h.online();
  assert.equal(h.accessory.getService(hap.Service.GarageDoorOpener), h.originalService);
  assert.equal(h.accessory.context.frontGateFsm, undefined);
  assert.equal(await h.current.handleGetRequest(), hap.Characteristic.CurrentDoorState.CLOSED);
  assert.equal(await h.target.handleGetRequest(), hap.Characteristic.TargetDoorState.CLOSED);
  h.contact(false);
  await immediate();
  assert.equal(h.client.publications.length, 0);
});

test('retained contact before connected packets and SUBACK is accepted as a baseline', async t => {
  const h = accessoryHarness(t, { delayed: true });
  h.online(true);
  h.client.callbacks.splice(0).forEach(callback => callback());
  assert.equal(await h.current.handleGetRequest(), hap.Characteristic.CurrentDoorState.CLOSED);
  assert.equal(h.client.publications.length, 0);
});

test('unknown required sensor state and missing mapping make HomeKit unavailable', async t => {
  const h = accessoryHarness(t);
  h.online();
  h.client.message(`${sensorBase}/state/connected`, 'garbage');
  await assert.rejects(h.current.handleGetRequest());
  await assert.rejects(h.target.handleSetRequest(0));
  assert.equal(h.client.publications.length, 0);
  const missing = accessoryHarness(t, { validMapping: false });
  await assert.rejects(missing.current.handleGetRequest());
});

test('inverted contact mapping and malformed payloads retain source-specific semantics', async t => {
  const h = accessoryHarness(t, { options: { sensorInverted: true } });
  h.online();
  h.contact(false);
  assert.equal(await h.current.handleGetRequest(), hap.Characteristic.CurrentDoorState.CLOSED);
  h.client.message(`${sensorBase}/state/hi`, '{"hi":false}');
  await assert.rejects(h.current.handleGetRequest());
  assert.equal(h.client.publications.length, 0);
});

test('HAP cannot overwrite a synchronous failed OPEN with stale OPEN target intent', async t => {
  const h = accessoryHarness(t);
  h.online();
  h.client.onPublish = (_topic, _payload, callback) => {
    h.contact(false);
    h.contact(true); // OPEN actually caused closure before the publication callback.
    callback();
  };
  await h.target.handleSetRequest(hap.Characteristic.TargetDoorState.OPEN);
  await immediate();
  assert.equal(h.current.value, hap.Characteristic.CurrentDoorState.CLOSED);
  assert.equal(h.target.value, hap.Characteristic.TargetDoorState.CLOSED);
  assert.equal(await h.target.handleGetRequest(), hap.Characteristic.TargetDoorState.CLOSED);
  assert.equal(h.client.publications.length, 1);
});

for (const action of ['OPEN_CLOSE', ' open ', 'Close']) {
  test(`normalized ${action.trim()} command intent cancels requests without asserting a pulse`, async t => {
    const h = accessoryHarness(t);
    h.online();
    await h.target.handleSetRequest(0);
    h.client.message(`${base}/execute_action`, action);
    await immediate();
    assert.equal(h.adapter.fsm.getSnapshot().activeRequest, null);
    assert.equal(h.adapter.fsm.getSnapshot().estimate.kind, 'unknown');
    assert.equal(h.client.publications.length, 1);
  });
}

test('retained commands are ignored and MQTT 3.1.1 self matches remain ambiguous', async t => {
  const h = accessoryHarness(t, { version: 4 });
  h.online();
  await h.target.handleSetRequest(0);
  h.client.message(`${base}/execute_action`, 'open_close', { retain: true });
  assert.ok(h.adapter.fsm.getSnapshot().activeRequest);
  h.client.message(`${base}/execute_action`, 'open_close');
  assert.equal(h.adapter.fsm.getSnapshot().lastResult.reason, 'ambiguous-mqtt-open_close');
  h.client.message(`${base}/execute_action`, 'open_close');
  assert.equal(h.adapter.fsm.getSnapshot().estimate.kind, 'unknown');
  assert.equal(h.client.publications.length, 1);
});

test('debouncing blocks new commands and cancels contact noise before it can become a false anchor', async t => {
  const h = accessoryHarness(t, { options: { sensorDebounceMs: 15 } });
  h.online();
  await assert.rejects(h.target.handleSetRequest(0));
  await new Promise(resolve => setTimeout(resolve, 20));
  await h.target.handleSetRequest(0);
  h.contact(false);
  await new Promise(resolve => setTimeout(resolve, 20));
  h.contact(true);
  h.contact(false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.notEqual(h.adapter.fsm.getSnapshot().estimate.kind, 'closed');
  assert.equal(h.client.publications.length, 1);
});

test('native sidecar events are optional read-only interference; duplicate/gap/reboot streams never toggle', () => {
  const observed = [];
  const gaps = [];
  const observer = new NativeGateObserver('10', '20', () => observed.push('accepted'), reason => gaps.push(reason), () => 10000);
  const receive = (extra = {}, retained = false) => observer.receive(Buffer.from(JSON.stringify({
    version: 1, source: 'native-srpc', kind: 'device-accepted', deviceId: '10', channelId: '20', observedAt: 10000, ...extra,
  })), retained);
  receive({}, true);
  assert.equal(observed.length, 0);
  receive();
  assert.equal(observed.length, 1);
  receive({ sessionId: 'one', sequence: 1 });
  receive({ sessionId: 'one', sequence: 2 });
  receive({ sessionId: 'one', sequence: 2 });
  assert.equal(observed.length, 2);
  receive({ sessionId: 'one', sequence: 4 });
  receive({ sessionId: 'two', sequence: 1 });
  assert.equal(gaps.length, 3);
  receive({ observedAt: 0 });
  receive({ channelId: '99' });
  assert.equal(gaps.length, 5);
  assert.equal(observed.length, 2);
});

test('optional sidecar topic must be granted; native acceptance cancels an active HomeKit request', async t => {
  const topic = 'gate-observer/10/20/events';
  const h = accessoryHarness(t, { options: { observationTopic: topic } });
  h.online();
  await h.target.handleSetRequest(0);
  h.client.message(topic, JSON.stringify({
    version: 1, source: 'native-srpc', kind: 'device-accepted', deviceId: '10', channelId: '20', observedAt: Date.now(),
  }));
  assert.equal(h.adapter.fsm.getSnapshot().activeRequest, null);
  assert.equal(h.adapter.fsm.getSnapshot().estimate.kind, 'unknown');
  assert.equal(h.client.publications.length, 1);
});

test('live discovery of a second gate revokes a cached global sensor mapping without replacing its service identity', async t => {
  const { SuplaPlatform } = require('../dist/platform');
  const client = new MockMqtt();
  const transport = new GateMqttTransport(client, log);
  const api = new EventEmitter();
  api.hap = hap;
  api.platformAccessory = function (name, uuid) {
    const accessory = new hap.Accessory(name, uuid);
    accessory.context = {};
    return accessory;
  };
  api.updatePlatformAccessories = () => {};
  api.registerPlatformAccessories = () => {};
  api.unregisterPlatformAccessories = () => {};
  const config = {
    name: 'Test', platform: 'SuplaPlatform', channels: JSON.stringify([control]),
    frontGateSensorDeviceId: 10, frontGateSensorChannelId: 21, frontGateSensorDebounceMs: 0,
  };
  const platform = new SuplaPlatform(log, config, api);
  platform.getGateMqttTransport = () => transport;
  const accessory = new api.platformAccessory('Front gate', hap.uuid.generate('cached-front-gate'));
  accessory.context.device = control;
  platform.configureAccessory(accessory);
  const service = accessory.getService(hap.Service.GarageDoorOpener);
  client.message(`${base}/state/connected`, true);
  client.message(`${sensorBase}/state/connected`, true);
  client.message(`${sensorBase}/state/hi`, true);
  assert.equal(await service.getCharacteristic(hap.Characteristic.CurrentDoorState).handleGetRequest(), 1);
  platform.discoverDevices([control, otherControl]);
  assert.equal(accessory.getService(hap.Service.GarageDoorOpener), service);
  await assert.rejects(service.getCharacteristic(hap.Characteristic.CurrentDoorState).handleGetRequest());
  await assert.rejects(service.getCharacteristic(hap.Characteristic.TargetDoorState).handleSetRequest(0));
  assert.equal(client.publications.length, 0);
  t.after(() => { platform.unregisterAllMqttHandlers(); transport.dispose(); });
});
