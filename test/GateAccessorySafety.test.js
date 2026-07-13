'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {GateAccessory} = require('../dist/Accesories/GateAccessory.js');

function channel(deviceId, channelId, channelFunction, channelType, caption) {
  return {
    topic: `supla/user/devices/${deviceId}/channels/${channelId}`,
    deviceId,
    channelId,
    channelFunction,
    channelType,
    channelCaption: caption,
  };
}

function createResolver(channels, config = {}, fallback = false) {
  const errors = [];
  const resolver = Object.create(GateAccessory.prototype);
  resolver.accessory = {displayName: 'Front Gate'};
  resolver.context = channel('1', '1', 'CONTROLLINGTHEGATE', 'RELAY', 'Front Gate');
  resolver.controlBaseTopic = resolver.context.topic;
  resolver.platform = {
    config,
    getKnownChannels: () => channels,
    normalizeTopicBase: topic => topic.replace(/\/+$/, '').replace(/\/state\/[^/]+$/, ''),
    shouldFallbackFrontGateSensorToControlChannel: () => fallback,
    log: {
      error: message => errors.push(message),
      info: () => undefined,
      warn: () => undefined,
    },
  };
  return {errors, resolver};
}

test('automatic pairing rejects a lone low-confidence window sensor', () => {
  const candidate = channel('2', '2', 'OPENINGSENSOR_WINDOW', 'BINARYSENSOR', 'Kitchen Window');
  const {errors, resolver} = createResolver([candidate]);

  assert.equal(resolver.resolveSensorBaseTopic(), undefined);
  assert.equal(errors.length, 1);
});

test('automatic pairing rejects equal-scoring gate sensors', () => {
  const first = channel('2', '2', 'OPENINGSENSOR_GATE', 'BINARYSENSOR', 'Gate A');
  const second = channel('3', '3', 'OPENINGSENSOR_GATE', 'BINARYSENSOR', 'Gate B');
  const {errors, resolver} = createResolver([first, second]);

  assert.equal(resolver.resolveSensorBaseTopic(), undefined);
  assert.match(errors[0], /ambiguous/);
});

test('an explicit sensor ID override wins deterministically', () => {
  const first = channel('2', '2', 'OPENINGSENSOR_GATE', 'BINARYSENSOR', 'Gate A');
  const second = channel('3', '3', 'OPENINGSENSOR_GATE', 'BINARYSENSOR', 'Gate B');
  const {resolver} = createResolver([first, second], {
    frontGateSensorDeviceId: '3',
    frontGateSensorChannelId: '3',
  });

  assert.equal(resolver.resolveSensorBaseTopic(), second.topic);
});

test('a partial sensor ID override must still resolve uniquely', () => {
  const first = channel('2', '7', 'OPENINGSENSOR_GATE', 'BINARYSENSOR', 'Gate A');
  const second = channel('3', '7', 'OPENINGSENSOR_GATE', 'BINARYSENSOR', 'Gate B');
  const {errors, resolver} = createResolver([first, second], {
    frontGateSensorChannelId: '7',
  });

  assert.equal(resolver.resolveSensorBaseTopic(), undefined);
  assert.equal(errors.length, 1);
});

test('control-channel fallback requires explicit opt-in', () => {
  const {resolver} = createResolver([], {}, true);
  assert.equal(resolver.resolveSensorBaseTopic(), resolver.controlBaseTopic);
});
