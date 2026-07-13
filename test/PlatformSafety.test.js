'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {SuplaPlatform} = require('../dist/platform.js');

function createBarePlatform() {
  const platform = Object.create(SuplaPlatform.prototype);
  platform.log = {
    error: () => undefined,
  };
  return platform;
}

test('front-gate actions always publish with QoS 0 and retain false', async () => {
  const platform = createBarePlatform();
  let publication;
  platform.MqttClient = {
    client: {
      connected: true,
      publish: (topic, payload, options, callback) => {
        publication = {topic, payload, options};
        callback();
      },
    },
  };

  await new Promise((resolve, reject) => {
    platform.publishGateAction('gate/execute_action', 'open_close', error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  assert.deepEqual(publication, {
    topic: 'gate/execute_action',
    payload: 'open_close',
    options: {qos: 0, retain: false},
  });
});

test('strict boolean parsing rejects malformed sensor payloads', () => {
  const platform = createBarePlatform();
  assert.equal(platform.parseBooleanStrict('true'), true);
  assert.equal(platform.parseBooleanStrict('OFF'), false);
  assert.equal(platform.parseBooleanStrict(1), true);
  assert.equal(platform.parseBooleanStrict(0), false);
  assert.equal(platform.parseBooleanStrict('unknown'), undefined);
  assert.equal(platform.parseBooleanStrict(2), undefined);
});
