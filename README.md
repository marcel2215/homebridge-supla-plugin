<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

<span align="center">

# Homebridge Supla Plugin

[![npm](https://img.shields.io/npm/v/homebridge-supla-plugin.svg)](https://www.npmjs.com/package/homebridge-supla-plugin) [![npm](https://img.shields.io/npm/dt/homebridge-supla-plugin.svg)](https://www.npmjs.com/package/homebridge-supla-plugin)

</span>

This is an accessory plugin for Supla devices. It allows you to control your Supla devices with HomeKit and Siri.

Supports Homebridge 1.6 or later, including Homebridge 2.1.1. Homebridge 2 requires Node.js 22.12 or 24.

### How it works

This plugin uses the mqtt protocol to communicate with the Supla server. It subscribes to the topics of the devices you want to control and publishes the commands you send to the devices.


### How to use

1. Install the plugin
```shell
$ npm i homebridge-supla-plugin
```
2. Configure the plugin. You can find your MQTT credentials in the [Supla Cloud](https://cloud.supla.org/).
3. Restart Homebridge
4. Plugin will automatically discover your devices and add them to HomeKit

### Front-gate safety model

Supla front gates controlled through the non-idempotent `open_close` action need a closed end-stop sensor. If the sensor is on a
separate channel, the plugin pairs it only when there is one unambiguous candidate. Configure one of these overrides if automatic
pairing is not possible:

```json
{
  "frontGateSensorTopic": "supla/USER/devices/123/channels/456"
}
```

Alternatively, use `frontGateSensorDeviceId` and `frontGateSensorChannelId`. A missing or ambiguous sensor keeps the gate unavailable.
The legacy control-channel sensor fallback is disabled unless `frontGateSensorFallbackToControlChannel` is explicitly enabled.

With only a closed sensor, `false` means “not fully closed”; it does not prove that the gate is fully open or reveal its direction.
The plugin therefore reports an unproven non-closed position as HomeKit `STOPPED` and rejects ambiguous open and close requests by
default:

```json
{
  "frontGateUnknownOpenPolicy": "reject",
  "frontGateUnknownClosePolicy": "reject",
  "frontGateAssumeOpenAfterTravel": false
}
```

Optional compatibility policies are:

- `accept_non_closed` for open requests: accepts any non-closed position without sending a pulse.
- `single_pulse_best_effort` for close requests: sends one pulse but continues reporting `STOPPED` until hard evidence arrives.
- `seek_closed` for close requests: sends up to `frontGateSeekClosedMaxPulses` pulses, one full travel interval apart, until the closed
  sensor activates. The search can initially move the gate in the opposite direction and must only be enabled with that behavior
  understood.

`frontGateAssumeOpenAfterTravel` is also an approximation and is disabled by default. An IR remote cannot be observed by the plugin,
so external IR use can always invalidate a direction estimate until new sensor evidence arrives.

Front-gate action publications always use MQTT QoS 0 and `retain: false`, independently of the global command settings. Retained
`execute_action` messages are ignored by the state estimator; any old retained action already stored on the broker should be removed.
MQTT 5 enables a No Local subscription for safer self-echo handling by setting `mqttProtocolVersion` to `5`, if the broker supports it.
