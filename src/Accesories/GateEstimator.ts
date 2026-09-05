export type GateTarget = 'open' | 'closed';
export type MotionDirection = 'opening' | 'closing';
export type GateEvidence = 'contact-confirmed' | 'attempted-unconfirmed' | 'published-unconfirmed'
  | 'relay-observed' | 'departure-observed' | 'unknown';
export type PositionInterval = { min: number; max: number };

export interface GateTiming {
  openingTravelMs: number;
  closingTravelMs: number;
  travelUncertainty: number;
  actuationDelayMs: number;
}

export type GateEstimate =
  | { kind: 'closed'; evidence: 'contact-confirmed' }
  | { kind: 'open'; evidence: GateEvidence }
  | {
    kind: 'moving';
    direction: MotionDirection;
    evidence: GateEvidence;
    origin: PositionInterval;
    startedAt: number;
    delayMs: number;
    earliestEnd: number;
    latestEnd: number;
  }
  | { kind: 'stopped'; nextDirection: MotionDirection; position: PositionInterval; evidence: GateEvidence }
  | { kind: 'unknown'; evidence: 'unknown' };

export const unknownEstimate = (): GateEstimate => ({ kind: 'unknown', evidence: 'unknown' });
export const oppositeDirection = (direction: MotionDirection): MotionDirection => direction === 'opening' ? 'closing' : 'opening';
export const targetDirection = (target: GateTarget): MotionDirection => target === 'open' ? 'opening' : 'closing';
const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function positionAt(estimate: GateEstimate, now: number, timing: GateTiming): PositionInterval {
  switch (estimate.kind) {
    case 'closed': return { min: 0, max: 0 };
    case 'open': return { min: 1, max: 1 };
    case 'unknown': return { min: 0, max: 1 };
    case 'stopped': return { ...estimate.position };
    case 'moving': {
      const travel = estimate.direction === 'opening' ? timing.openingTravelMs : timing.closingTravelMs;
      const least = Math.max(0, now - estimate.startedAt - estimate.delayMs) / (travel * (1 + timing.travelUncertainty));
      const most = Math.max(0, now - estimate.startedAt) / (travel * (1 - timing.travelUncertainty));
      return estimate.direction === 'opening'
        ? { min: clamp(estimate.origin.min + least), max: clamp(estimate.origin.max + most) }
        : { min: clamp(estimate.origin.min - most), max: clamp(estimate.origin.max - least) };
    }
  }
}

export function startMotion(
  position: PositionInterval, direction: MotionDirection, now: number, timing: GateTiming,
  evidence: GateEvidence, delayMs = timing.actuationDelayMs,
): GateEstimate {
  const travel = direction === 'opening' ? timing.openingTravelMs : timing.closingTravelMs;
  const leastRemaining = direction === 'opening' ? 1 - position.max : position.min;
  const mostRemaining = direction === 'opening' ? 1 - position.min : position.max;
  return {
    kind: 'moving', direction, evidence, origin: { ...position }, startedAt: now, delayMs,
    earliestEnd: now + leastRemaining * travel * (1 - timing.travelUncertainty),
    latestEnd: now + delayMs + mostRemaining * travel * (1 + timing.travelUncertainty),
  };
}

export function canStopBeforeEndpoint(estimate: GateEstimate, now: number, timing: GateTiming): boolean {
  return estimate.kind === 'moving' && now + timing.actuationDelayMs < estimate.earliestEnd;
}

/** Conditional physical estimate only: this never authorizes a command. */
export function applyEstimatedPulse(
  estimate: GateEstimate, now: number, timing: GateTiming, evidence: GateEvidence, delayMs = timing.actuationDelayMs,
): GateEstimate {
  switch (estimate.kind) {
    case 'closed': return startMotion({ min: 0, max: 0 }, 'opening', now, timing, evidence, delayMs);
    case 'open': return startMotion({ min: 1, max: 1 }, 'closing', now, timing, evidence, delayMs);
    case 'stopped': return startMotion(estimate.position, estimate.nextDirection, now, timing, evidence, delayMs);
    case 'unknown': return unknownEstimate();
    case 'moving': {
      if (now + delayMs >= estimate.earliestEnd) {
        return unknownEstimate();
      }
      const before = positionAt(estimate, now, timing);
      const after = positionAt(estimate, now + delayMs, timing);
      return {
        kind: 'stopped', nextDirection: oppositeDirection(estimate.direction), evidence,
        position: { min: Math.min(before.min, after.min), max: Math.max(before.max, after.max) },
      };
    }
  }
}
