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

### Front gate configuration and behavior

Front gates (`CONTROLLINGTHEGATE`) use finite, cancellable `open_close` requests. An unexpected closure during OPEN updates HomeKit to CLOSED and sends no recovery pulse. Unknown state is rejected by default; estimated full opening and two-pulse reversals require explicit opt-ins.

Configure an exact control-to-contact mapping for each gate using [this example](examples/front-gate.json). Previous caption-based sensor selection and seek/retry behavior are disabled. MQTT 3.1.1 cannot reliably identify own command echoes, so ambiguous echoes cancel pending requests; MQTT 5 `noLocal` can improve this when supported by your broker.

Read the [front gate configuration, migration and observation guide](docs/FRONT_GATE.md) before updating an existing gate installation. Run `npm test` for production controller and adapter tests, or `npm run test:report` to regenerate the [machine-readable validation report](docs/gate-validation.json).
