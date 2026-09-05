# Front gate requests and migration

The `CONTROLLINGTHEGATE` accessory sends **`open_close` only**. Each HomeKit SET creates one finite request with a fixed budget of zero, one or two publication attempts. A terminal result cancels all unsent steps and clears the active target. Timers, reconnection, contact readings and characteristic GET/reporting do not create requests or recovery pulses.

If OPEN actually closes the gate, a valid closed contact ends that OPEN request, sets both HomeKit values to CLOSED, and establishes that the next pulse opens. The plugin does nothing further. A later explicit SET is a new authorization. Same-target writes are deduplicated only while a compatible request remains active; HomeKit supplies no reliable human-gesture identifier for distinguishing every retransmission from a new tap.

## Migration from earlier versions

1. Add a `frontGates` entry for **each exact control device/channel** and map its closed contact. Use the [configuration example](../examples/front-gate.json); its IDs are placeholders. Caption similarity, device proximity and discovery order no longer select a contact. Invalid or missing mappings disable that gate's requests.
2. Remove `frontGateCloseRetryLimit`, `frontGateSeekClosedMaxPulses` and `frontGateWrongDirectionRunMs`. The `seek_closed` policy is disabled, including legacy `frontGateUnknownClosePolicy` values. Legacy settings produce a warning and cannot authorize recovery. The new `unknownTargetPolicy` defaults to `reject`; its only movement option is `single_pulse_best_effort`.
3. Estimated full opening and speculative two-pulse reversals now require separate opt-ins. Both default to **false**. Three-pulse wrong-way maneuvers are unavailable.
4. Front-gate commands ignore general `gateExecuteActionOpen/Close/Toggle`, `commandQos` and `commandRetain`. Their only payload is `open_close`, with QoS 0 and retention disabled. General settings still apply to other accessory implementations.
5. Restart Homebridge after configuration changes. Existing accessory UUIDs and the GarageDoorOpener service are reused. Old persisted motion state is discarded. Rediscovery revalidates mappings and cancels the old controller's request; it never resumes a pending target.

The legacy `frontGateSensorDeviceId`/`frontGateSensorChannelId` or `frontGateSensorTopic` override remains usable only when the complete known channel list proves that there is exactly one gate. New per-gate entries do not inherit a global contact. Discovery of another gate revokes that legacy mapping. Global `frontGateFullTravelMs`, `frontGateReversePauseMs` and `frontGateMinimumPulseGapMs` remain defaults; per-gate timing fields take precedence. The obsolete wrong-direction/retry fields are absent from the configuration UI.

The front-gate path is separate from garage-door, lock and covering implementations. This change does not rewrite their command behavior.

## Contact mapping and polarity

Choose either both `sensorDeviceId` and `sensorChannelId`, or an exact `sensorTopic` base. A base has `/state/hi` for the contact and `/state/connected` for its availability. IDs resolve within the control channel's cloud topic prefix, so sensor discovery order is irrelevant. Wildcards, action paths, duplicate control mappings, mixed ID/topic selectors and mapping the motor channel itself are rejected.

The cloud motor channel's `/state/hi` projects its associated closed contact: true means closed in the audited SUPLA source. It is **not relay state**. That projection can turn an unavailable sensor level into false, so this implementation requires a separate mapped contact with its own availability. It does not claim to discover a verified SUPLA control-to-sensor association from the existing discovery payload.

Check the actual mapped sensor's semantics; use `sensorInverted` where needed. Accepted values are true/false, 1/0, on/off and yes/no, case-insensitively. Malformed values invalidate contact availability instead of silently becoming false. Device-local MQTT is a different protocol surface; a topic override alone does not provide a local command adapter.

Control availability, sensor availability and every required MQTT subscription must be healthy. A connection/subscription gap invalidates the observation epoch. Retained state may establish the first baseline of the new epoch, but it never represents movement history and cannot overwrite live state later in that epoch, during a request, or after ambiguous delivery. A receive timestamp is not proof of when the device measured a retained level.

Contact edges are debounced. A changing contact immediately cancels unsent reversal steps, and new SETs are rejected while a contact is being debounced. A repeated live CLOSED level during opening startup is ignored for `departureGraceMs`; a new closing edge is still authoritative. A later repeated live CLOSED sample can repair an unknown estimate. A release associated with an already-started opening does not restart its travel clock.

## Estimates and fixed plans

Physical estimates are separate from request records. A stopped estimate keeps its position interval and next direction even after the request ends. Local publication attempts create conditional estimates, progressing from `attempted-unconfirmed` to `published-unconfirmed` if the callback succeeds. A callback does not acknowledge a motor-input edge. Contact/departure and genuinely observed relay edges have different evidence labels.

| Estimated state | Request | Fixed plan |
| --- | --- | --- |
| Closed | Open | One pulse |
| Open, explicitly estimated | Closed | One pulse |
| Already at target | Same target | No pulse; terminal result |
| Moving toward target | Same target | No pulse; finite observation request |
| Moving away | Opposite endpoint | Opt-in stop, pause, reverse; two pulses maximum |
| Stopped, next direction toward target, interval clear of endpoints | That endpoint | One pulse |
| Stopped with wrong/uncertain next direction | Other endpoint | Reject |
| Unknown | Either endpoint | Reject by default; optionally exactly one best-effort pulse |

The reversal's second step is part of the original plan, not a retry. It still requires the same request and generation, remaining budget, healthy observations, adequate spacing and unchanged physical preconditions. An opposite SET cancels unsent work; it does not defer the new target until an endpoint or create an automatic return journey.

Opening and closing have independent nominal travel times. `travelUncertainty` expands those into speed bounds. Position intervals accumulate elapsed motion, and reversal timing uses **remaining distance**. For example, opening from approximately 68% requires approximately 8 seconds at a nominal 25-second full travel, not another 25 seconds. A stop/reverse plan is rejected if a possible endpoint makes the next pulse ambiguous.

| Per-gate field | Default | Meaning |
| --- | --- | --- |
| `openingTravelMs`, `closingTravelMs` | 25000 each | Nominal full travel, each constrained to 5000–120000 ms |
| `travelUncertainty` | 0.1 | Fractional travel-time range, 0–0.5 |
| `actuationDelayMs` | 2500 | Maximum assumed delivery/start delay, 0–15000 ms |
| `sensorDelayMs` | 1000 | Assumed reporting lag; widens external departure position and closure deadline |
| `sensorDebounceMs` | 200 | Contact debounce, 0–2000 ms |
| `departureGraceMs` | 4000 | Ignore repeated old CLOSED during opening startup |
| `minimumPulseGapMs`, `reversePauseMs` | 3000 each | At least 3000 ms; maximum 30000 ms each |
| `relayHighMs`, `relayReleaseMarginMs` | 500 each | Relay hold and release allowance |
| `publishTimeoutMs` | 2500 | Publication callback deadline, 100–5000 ms |
| `unknownTargetPolicy` | `reject` | Alternative: `single_pulse_best_effort` |
| `assumeOpenAfterTravel` | false | Permit estimated OPEN after the latest estimated arrival |
| `allowSpeculativeSequences` | false | Permit a fixed two-pulse reversal from uninterrupted estimates |

The effective pulse gap is the largest of the minimum gap, reversal pause, and relay-high + release-margin + actuation-delay allowance. Spacing includes local attempts with uncertain delivery and external observations. Reasserting a relay while it is high may not create another motor-input edge.

These timing bounds are configuration assumptions, not measurements or safety guarantees. Hidden remote stops, motor auto-close, photocell reversals, obstacles or manual release can invalidate them. Calibrate through supervised normal operation; there is no automatic seek/calibration sequence. A closed-only contact cannot distinguish arbitrary mid-travel states. Even a second endpoint contact does not identify every stopped next direction.

## MQTT and cancellation

All front gates share a dedicated actuation/observation MQTT client. It uses `clean:true`, `queueQoSZero:false`, `resubscribe:false`, exact subscriptions and non-retained QoS 0 commands. Other accessories retain their existing client options. Subscription recovery may retry; actuator publication never retries. A missing, empty or denied SUBACK is not treated as permission to operate. Old-epoch SUBACKs and publication callbacks cannot restore a cancelled request.

`frontGateMqttProtocolVersion` defaults to **4 (MQTT 3.1.1)** for broker compatibility. Under this protocol, an identical external command can look like the plugin's own echo. The adapter explicitly classifies a possible own echo as **ambiguous**, cancels the request and invalidates its estimate. This can leave a successfully moving gate displayed as STOPPED, and it prevents a speculative reversal from continuing after such an echo. Payload matching never proves execution.

Use **5 only if the broker supports MQTT 5**. The dedicated client requests `noLocal` on every exact subscription and has no overlapping discovery wildcard. This removes same-client echoes; it still does not turn another client's command into proof of an applied pulse. There is no automatic protocol downgrade. Applicable `open_close`, `open`, `close` and `stop` intent strings are normalized; retained command packets are ignored.

A publication timeout or error can occur after physical delivery. The request then ends as unconfirmed and the estimate becomes unknown; it is never restored from the last cached CLOSED value. Only a definite pre-write rejection can preserve the previous estimate, and even that cannot overwrite newer contact evidence. A write already handed to the network cannot be unsent; cancellation guarantees concern **unsent steps and future controller actions**.

This plugin cannot prevent independently configured SUPLA server tasks, schedules, integrations or a remote from sending other pulses. Switching to server-side `open`/`close` would move endpoint interpretation and possible retries outside this request controller, so those payloads are never used here.

## Optional native observer boundary

An optional `observationTopic` connects a read-only native SUPLA sidecar to one gate. This patch supplies the consumer/interface, **not an SRPC implementation or a deployed sidecar**. Normal MQTT installations need no native dependency. When configured, the telemetry topic's subscription becomes required for gate availability.

Publish non-retained JSON on a separate exact telemetry topic:

```json
{
  "version": 1,
  "source": "native-srpc",
  "kind": "device-accepted",
  "deviceId": "123",
  "channelId": "456",
  "observedAt": 1788602400000
}
```

`observedAt` is an illustrative Unix timestamp in milliseconds; use the actual source observation time. Events older than 5 seconds or more than 1 second in the future invalidate the estimate. IDs must match the configured gate as strings. A sidecar that has a real ordered connection stream may additionally provide a nonempty `sessionId` and nonnegative integer `sequence`; duplicates are ignored, and first samples, gaps and session changes establish a baseline by invalidating the estimate. These fields are a sidecar contract, not a claim that native SRPC already supplies a boot counter.

The sidecar must emit `kind:"gap"` with the same version, source and gate identity when native observation continuity is lost. It should signal continuity loss on startup/reconnect and never replay accepted operations as fresh events. MQTT subscription health alone does not prove the native connection is alive; a sidecar must report its own failures. Invalid telemetry cancels pending work and cannot become a command.

Native device acceptance is used **only for interference cancellation**, not to advance pulse direction. Its advertised coverage is `native-app-commands-only`. Existing cloud MQTT has no universal event stream for all app, schedule, direct-link, integration and remote actions. Broader software coverage requires server/device instrumentation. A remote connected directly to the motor board needs observations at that controller or its inputs.

`handleAppliedPulse` is a separate typed boundary for future genuinely observed motor-input edges, with optional exact local correlation and monotonic event time. It is not wired to raw MQTT or native acceptance. A provider must guarantee deduplicated, contiguous events, report gaps, and supply real edge timestamps. Own duplicate correlations do not toggle twice; stale/out-of-window evidence invalidates the timeline. Firmware counters must count inactive-to-active edges, not every relay API call. None of that instrumentation is assumed to exist on an installed device.

## HomeKit and diagnostics

- CLOSED represents the mapped closed contact. OPENING/CLOSING are bounded estimates. OPEN is permitted only by the explicit estimated-open option in this closed-only integration.
- STOPPED is the lossy HomeKit representation for unknown or partially stopped state; it does not prove the motor is stopped.
- The requested target is shown only while its request is active. After termination, target falls back to CLOSED for a closed estimate and OPEN otherwise. That fallback is not a full-open claim or a new command.
- Reporting uses `updateCharacteristic`. A deferred reporting refresh also accounts for HAP storing the written value after `onSet` resolves. No reporting path invokes the actuator setter.
- Unavailable GETs/SETs return a HAP communication error. Characteristic errors do not guarantee an immediate Apple Home “No Response” notification. ObstructionDetected is not used as an uncertainty alarm; this integration has no obstruction telemetry.
- Logs include control identity, request/correlation ID, step, pulse budget and terminal outcome. MQTT intent, publication handling, device acceptance and applied-edge evidence remain distinct. No credentials or direct-link URLs are included in gate diagnostics.

A separate momentary pulse switch and a three-pulse maneuver are outside this patch.

## Reproducible validation

```sh
npm run lint
npm test
npm run test:report
```

The tests use the **compiled production controller**, an independent virtual motor, mocked MQTT adapters, real MQTT.js offline queuing behavior and real HAP characteristic handlers. The history checks cover 4,096 six-step visible histories and 2,000 seeded 15-step fault histories; they are bounded tests, not proof of all hardware behavior. Invariants check each request's budget and prohibit actuator effects after its terminal result.

The report command writes [gate-validation.json](gate-validation.json) and `test-results/gate-tests.tap`. It also replays the immutable checkout baseline `18de144` in an isolated virtual controller: a hidden remote stop/close during OPEN causes the old code to publish a second, reopening pulse. The revised implementation is tested to stop at CLOSED. The separate “OPEN actually closes” scenario remains closed after another 250 simulated seconds.

The report records the Node runtime and installed Homebridge dependency used. Additional compatibility checks can point `SUPLA_TEST_HAP_PATH` at the HAP package from an isolated Homebridge installation and run `node --test test/GateAdapters.test.js`. No test connects to a live gate or broker. Physical gate timing, native sidecar connectivity and Apple Home presentation still require supervised installation validation.

The recorded compatibility check used Node 24.20.0: the full suite passed with Homebridge 2.1.1, and the adapter suite also passed using the HAP dependency from Homebridge 1.6.0. These exercise HAP handlers and platform discovery in isolation, rather than running a live Homebridge installation.
