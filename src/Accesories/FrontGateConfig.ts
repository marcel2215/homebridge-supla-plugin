import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';
import { GateTiming } from './GateEstimator';

export interface FrontGateTimingConfig extends GateTiming {
  fullTravelMs: number;
  reversePauseMs: number;
  minimumPulseGapMs: number;
  relayHighMs: number;
  relayReleaseMarginMs: number;
  publishTimeoutMs: number;
  departureGraceMs: number;
  sensorDebounceMs: number;
  sensorDelayMs: number;
  assumeOpenAfterTravel: boolean;
  allowSpeculativeSequences: boolean;
  unknownTargetPolicy: 'reject' | 'single_pulse_best_effort';
}

export const DEFAULT_FRONT_GATE_TIMINGS: FrontGateTimingConfig = {
  fullTravelMs: 25000, openingTravelMs: 25000, closingTravelMs: 25000,
  travelUncertainty: 0.1, actuationDelayMs: 2500, reversePauseMs: 3000, minimumPulseGapMs: 3000,
  relayHighMs: 500, relayReleaseMarginMs: 500, publishTimeoutMs: 2500, departureGraceMs: 4000,
  sensorDebounceMs: 200, sensorDelayMs: 1000,
  assumeOpenAfterTravel: false, allowSpeculativeSequences: false, unknownTargetPolicy: 'reject',
};

type Config = Record<string, unknown>;
const object = (value: unknown): Config => value && typeof value === 'object' && !Array.isArray(value) ? value as Config : {};
const bool = (value: unknown) => value === true || value === 'true';
const id = (value: unknown): string | undefined => /^\d+$/.test(String(value)) ? String(value) : undefined;
const number = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function normalizeFrontGateTimings(raw: Config = {}, warn: (message: string) => void = () => undefined): FrontGateTimingConfig {
  const d = DEFAULT_FRONT_GATE_TIMINGS;
  const fullTravelMs = number(raw.fullTravelMs, d.fullTravelMs, 5000, 120000);
  const removedSeek = raw.unknownTargetPolicy === 'seek_closed' || raw.unknownClosePolicy === 'seek_closed';
  if (removedSeek || raw.seekClosedMaxPulses !== undefined || raw.closeRetryLimit !== undefined || raw.wrongDirectionRunMs !== undefined) {
    warn('Legacy gate seek/retry/wrong-direction options are disabled. Unknown targets default to reject; no recovery pulses are sent.');
  }
  return {
    fullTravelMs,
    openingTravelMs: number(raw.openingTravelMs, fullTravelMs, 5000, 120000),
    closingTravelMs: number(raw.closingTravelMs, fullTravelMs, 5000, 120000),
    travelUncertainty: number(raw.travelUncertainty, d.travelUncertainty, 0, 0.5),
    actuationDelayMs: number(raw.actuationDelayMs, d.actuationDelayMs, 0, 15000),
    reversePauseMs: number(raw.reversePauseMs, d.reversePauseMs, 3000, 30000),
    minimumPulseGapMs: number(raw.minimumPulseGapMs, d.minimumPulseGapMs, 3000, 30000),
    relayHighMs: number(raw.relayHighMs, d.relayHighMs, 0, 15000),
    relayReleaseMarginMs: number(raw.relayReleaseMarginMs, d.relayReleaseMarginMs, 0, 15000),
    publishTimeoutMs: number(raw.publishTimeoutMs, d.publishTimeoutMs, 100, 5000),
    departureGraceMs: number(raw.departureGraceMs, d.departureGraceMs, 0, 30000),
    sensorDebounceMs: number(raw.sensorDebounceMs, d.sensorDebounceMs, 0, 2000),
    sensorDelayMs: number(raw.sensorDelayMs, d.sensorDelayMs, 0, 15000),
    assumeOpenAfterTravel: bool(raw.assumeOpenAfterTravel),
    allowSpeculativeSequences: bool(raw.allowSpeculativeSequences),
    unknownTargetPolicy: !removedSeek && raw.unknownTargetPolicy === 'single_pulse_best_effort' ? 'single_pulse_best_effort' : 'reject',
  };
}

export interface ResolvedFrontGateConfig {
  timings: FrontGateTimingConfig;
  sensorBaseTopic?: string;
  sensorInverted: boolean;
  observationTopic?: string;
  error?: string;
}

/** An explicit contact mapping is the authorization boundary; captions never select a sensor. */
export function resolveFrontGateConfig(
  input: unknown, control: SuplaChannelContext, knownChannels: SuplaChannelContext[], warn: (message: string) => void,
): ResolvedFrontGateConfig {
  const config = object(input);
  const global: Config = {};
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('frontGate') && key.length > 9) {
      global[key[9].toLowerCase() + key.slice(10)] = value;
    }
  }
  const entries = Array.isArray(config.frontGates) ? config.frontGates.map(object) : [];
  const matches = entries.filter(entry => id(entry.deviceId) === control.deviceId && id(entry.channelId) === control.channelId);
  const options = { ...global, ...(matches[0] ?? {}) };
  const result: ResolvedFrontGateConfig = {
    timings: normalizeFrontGateTimings(options, warn), sensorInverted: bool(options.sensorInverted),
  };
  const fail = (message: string) => ({ ...result, error: message });
  if (matches.length > 1) {
    return fail('Duplicate frontGates entries for this control channel; actuation disabled.');
  }
  if (config.frontGates !== undefined && !Array.isArray(config.frontGates)) {
    return fail('frontGates must be an array of exact control/contact mappings.');
  }
  if (entries.length && !matches.length) {
    return fail('No frontGates entry matches this control channel; actuation disabled.');
  }
  if (!matches.length) {
    const gates = new Set(knownChannels.filter(channel => channel.channelFunction === 'CONTROLLINGTHEGATE')
      .map(channel => `${channel.deviceId}/${channel.channelId}`));
    if (gates.size !== 1 || !gates.has(`${control.deviceId}/${control.channelId}`)) {
      return fail('Configure an exact frontGates entry with its closed contact; a global sensor mapping is ambiguous.');
    }
    warn('Legacy global gate sensor mapping is supported only for one known gate. Migrate it to frontGates.');
  }
  // Never inherit a global contact into a per-gate entry.
  const mapping = matches[0] ?? global;
  const controlBase = control.topic.replace(/\/+$/, '');
  const prefix = controlBase.match(/^(.*)\/devices\/\d+\/channels\/\d+$/)?.[1];
  let sensor: string | undefined;
  if (typeof mapping.sensorTopic === 'string' && mapping.sensorTopic.trim()) {
    if (mapping.sensorDeviceId !== undefined || mapping.sensorChannelId !== undefined) {
      return fail('Choose either sensorTopic or the exact sensor device/channel IDs, not both.');
    }
    sensor = mapping.sensorTopic.trim().replace(/\/state\/hi$/, '').replace(/\/+$/, '');
    if (/[+#\s]/.test(sensor) || /\/(execute_action|set)(\/|$)/.test(sensor)) {
      return fail('The closed sensor topic must be an exact state channel base, without wildcards or action paths.');
    }
  } else if (prefix && id(mapping.sensorDeviceId) && id(mapping.sensorChannelId)) {
    sensor = `${prefix}/devices/${id(mapping.sensorDeviceId)}/channels/${id(mapping.sensorChannelId)}`;
  }
  if (!sensor || sensor === controlBase) {
    return fail('Map a separate closed contact and its availability channel. The motor projection alone cannot establish sensor health.');
  }
  result.sensorBaseTopic = sensor;
  if (mapping.observationTopic !== undefined) {
    const topic = mapping.observationTopic;
    if (typeof topic !== 'string' || !topic.trim() || /[+#\s]/.test(topic)
      || /\/(execute_action|set)(\/|$)/.test(topic) || topic === `${sensor}/state/hi`) {
      return fail('The optional native observer requires an exact, separate read-only telemetry topic.');
    }
    result.observationTopic = topic;
  }
  return result;
}
