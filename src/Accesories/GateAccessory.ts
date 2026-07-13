import { CharacteristicValue, HAPStatus, PlatformAccessory, Service } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';
import {
  DoorTargetState,
  FrontGateError,
  FrontGateFsm,
  FrontGateSnapshot,
} from './FrontGateFsm';

type FrontGateConfigView = {
  frontGateSensorTopic?: string;
  frontGateSensorDeviceId?: string | number;
  frontGateSensorChannelId?: string | number;
};

type SensorCandidate = {
  channel: SuplaChannelContext;
  baseTopic: string;
  score: number;
  reasons: string[];
};

export class GateAccessory {
  private readonly service: Service;
  private readonly controlBaseTopic: string;
  private readonly sensorBaseTopic?: string;
  private readonly fsm: FrontGateFsm;
  private pendingSelfCommandEchoCount = 0;
  private pendingSelfCommandEchoPayload?: string;
  private pendingSelfCommandEchoExpiresAt = 0;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'GateController');

    const legacyDoor = this.accessory.getService(this.platform.Service.Door);
    if (legacyDoor) {
      this.accessory.removeService(legacyDoor);
    }

    this.service = this.accessory.getService(this.platform.Service.GarageDoorOpener)
      || this.accessory.addService(this.platform.Service.GarageDoorOpener);
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
    this.removeStaleNonStandardCharacteristics();

    this.controlBaseTopic = this.platform.normalizeTopicBase(this.context.topic);
    this.sensorBaseTopic = this.resolveSensorBaseTopic();

    // Remove stale persisted direction state from the previous implementation.
    delete this.accessory.context.frontGateFsm;

    this.fsm = new FrontGateFsm(
      {
        pulseMotor: async (reason) => this.publishPulse(reason),
        publishSnapshot: (snapshot) => this.applySnapshot(snapshot),
        log: {
          debug: (message) => this.platform.log.debug(`[FrontGate ${this.accessory.displayName}] ${message}`),
          info: (message) => this.platform.log.info(`[FrontGate ${this.accessory.displayName}] ${message}`),
          warn: (message) => this.platform.log.warn(`[FrontGate ${this.accessory.displayName}] ${message}`),
        },
      },
      this.platform.getFrontGateConfig(),
    );

    this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(this.handleCurrentDoorStateGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onGet(this.handleTargetDoorStateGet.bind(this))
      .onSet(this.handleTargetDoorStateSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.ObstructionDetected)
      .onGet(this.handleObstructionDetectedGet.bind(this));

    this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, false);

    this.platform.registerOwnerCleanup(this.accessory.UUID, () => {
      this.fsm.dispose();
    });

    this.platform.registerMqttTransportHandler(
      connected => this.fsm.handleTransportConnectedChange(connected),
      this.accessory.UUID,
    );

    this.platform.registerMqttHandler(
      `${this.controlBaseTopic}/state/connected`,
      (message) => {
        this.handleStrictBooleanMessage(message, 'control connected', value => {
          this.fsm.handleControlConnectedChange(value);
        });
      },
      this.accessory.UUID,
    );

    if (this.sensorBaseTopic) {
      this.platform.registerMqttHandler(
        `${this.sensorBaseTopic}/state/connected`,
        (message) => {
          this.handleStrictBooleanMessage(message, 'sensor connected', value => {
            this.fsm.handleSensorConnectedChange(value);
          });
        },
        this.accessory.UUID,
      );

      this.platform.registerMqttHandler(
        `${this.sensorBaseTopic}/state/hi`,
        (message) => {
          this.handleStrictBooleanMessage(message, 'closed sensor', value => {
            this.fsm.handleClosedSensorChange(value);
          });
        },
        this.accessory.UUID,
      );
    }

    this.platform.registerMqttHandler(
      `${this.controlBaseTopic}/execute_action`,
      (message, _topic, packet) => {
        const payload = message.toString().trim();
        const expectedAction = this.platform.getFrontGatePulseAction().trim();
        if (!expectedAction || payload !== expectedAction) {
          return;
        }
        if (packet.retain) {
          this.platform.log.warn(
            `[FrontGate ${this.accessory.displayName}] ignoring retained execute_action message`,
          );
          return;
        }
        if (!this.platform.isMqttNoLocalAvailable() && this.shouldIgnoreObservedExecuteAction(payload)) {
          return;
        }
        this.fsm.handleObservedExternalPulse(
          `mqtt-execute_action:${payload}:qos=${packet.qos}:dup=${packet.dup}:id=${packet.messageId ?? 'none'}`,
        );
      },
      this.accessory.UUID,
      { noLocal: true },
    );

    this.applySnapshot(this.fsm.getSnapshot());
  }

  async handleCurrentDoorStateGet(): Promise<CharacteristicValue> {
    const snapshot = this.fsm.getSnapshot();
    if (!snapshot.available || snapshot.currentDoorState === undefined) {
      throw this.createHapError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return snapshot.currentDoorState;
  }

  async handleTargetDoorStateGet(): Promise<CharacteristicValue> {
    const snapshot = this.fsm.getSnapshot();
    if (!snapshot.available || snapshot.targetDoorState === undefined) {
      throw this.createHapError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return snapshot.targetDoorState;
  }

  async handleTargetDoorStateSet(value: CharacteristicValue) {
    if (typeof value !== 'number' || (value !== DoorTargetState.OPEN && value !== DoorTargetState.CLOSED)) {
      throw this.createHapError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const target = value === DoorTargetState.OPEN ? 'open' : 'closed';
    try {
      await this.fsm.requestHomeKitTarget(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.platform.log.warn(`Gate ${this.accessory.displayName} command failed: ${message}`);
      if (error instanceof this.platform.api.hap.HapStatusError) {
        throw error;
      }
      if (error instanceof FrontGateError) {
        throw this.mapFrontGateError(error);
      }
      throw this.createHapError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async handleObstructionDetectedGet(): Promise<CharacteristicValue> {
    return false;
  }

  private removeStaleNonStandardCharacteristics(): void {
    for (const characteristicType of [
      this.platform.Characteristic.StatusActive,
      this.platform.Characteristic.StatusFault,
    ]) {
      if (this.service.testCharacteristic(characteristicType)) {
        this.service.removeCharacteristic(this.service.getCharacteristic(characteristicType));
      }
    }
  }

  private handleStrictBooleanMessage(
    message: Buffer,
    label: string,
    handler: (value: boolean) => void,
  ): void {
    const rawValue = message.toString();
    const value = this.platform.parseBooleanStrict(rawValue);
    if (value === undefined) {
      this.platform.log.warn(
        `[FrontGate ${this.accessory.displayName}] ignoring invalid ${label} payload: ${JSON.stringify(rawValue)}`,
      );
      return;
    }
    handler(value);
  }

  private applySnapshot(snapshot: FrontGateSnapshot): void {
    this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, false);

    if (!snapshot.available || snapshot.currentDoorState === undefined || snapshot.targetDoorState === undefined) {
      return;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, snapshot.currentDoorState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, snapshot.targetDoorState);
  }

  private createHapError(status: HAPStatus): Error {
    return new this.platform.api.hap.HapStatusError(status);
  }

  private mapFrontGateError(error: FrontGateError): Error {
    switch (error.code) {
      case 'not_allowed':
        return this.createHapError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      case 'resource_busy':
        return this.createHapError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
      case 'operation_timed_out':
        return this.createHapError(this.platform.api.hap.HAPStatus.OPERATION_TIMED_OUT);
      case 'unavailable':
      case 'communication_failure':
        return this.createHapError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async publishPulse(reason: string): Promise<void> {
    const action = this.platform.getFrontGatePulseAction();
    if (!action) {
      throw new Error('front gate pulse action is not configured');
    }

    this.platform.log.debug(`Publishing ${this.controlBaseTopic}/execute_action = ${action} (${reason})`);
    if (!this.platform.isMqttNoLocalAvailable()) {
      this.noteExpectedSelfCommandEcho(action);
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.retractExpectedSelfCommandEcho(action);
        reject(new FrontGateError('operation_timed_out', 'MQTT gate action publication timed out'));
      }, 2500);

      this.platform.publishGateAction(`${this.controlBaseTopic}/execute_action`, action, (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) {
          this.retractExpectedSelfCommandEcho(action);
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private noteExpectedSelfCommandEcho(payload: string): void {
    this.prunePendingSelfCommandEcho();
    this.pendingSelfCommandEchoPayload = payload;
    this.pendingSelfCommandEchoCount += 1;
    this.pendingSelfCommandEchoExpiresAt = Date.now() + 5000;
  }

  private retractExpectedSelfCommandEcho(payload: string): void {
    this.prunePendingSelfCommandEcho();
    if (this.pendingSelfCommandEchoPayload !== payload || this.pendingSelfCommandEchoCount <= 0) {
      return;
    }

    this.pendingSelfCommandEchoCount -= 1;
    if (this.pendingSelfCommandEchoCount <= 0) {
      this.pendingSelfCommandEchoCount = 0;
      this.pendingSelfCommandEchoPayload = undefined;
      this.pendingSelfCommandEchoExpiresAt = 0;
    }
  }

  private shouldIgnoreObservedExecuteAction(payload: string): boolean {
    this.prunePendingSelfCommandEcho();
    if (this.pendingSelfCommandEchoPayload !== payload || this.pendingSelfCommandEchoCount <= 0) {
      return false;
    }

    this.pendingSelfCommandEchoCount -= 1;
    if (this.pendingSelfCommandEchoCount <= 0) {
      this.pendingSelfCommandEchoCount = 0;
      this.pendingSelfCommandEchoPayload = undefined;
      this.pendingSelfCommandEchoExpiresAt = 0;
    }
    return true;
  }

  private prunePendingSelfCommandEcho(): void {
    if (this.pendingSelfCommandEchoCount === 0) {
      return;
    }
    if (Date.now() <= this.pendingSelfCommandEchoExpiresAt) {
      return;
    }

    this.pendingSelfCommandEchoCount = 0;
    this.pendingSelfCommandEchoPayload = undefined;
    this.pendingSelfCommandEchoExpiresAt = 0;
  }

  private resolveSensorBaseTopic(): string | undefined {
    const explicit = this.resolveSensorOverrideFromConfig();
    if (explicit) {
      this.platform.log.info(
        `[FrontGate ${this.accessory.displayName}] using explicit front-gate sensor topic override: ${explicit}`,
      );
      return explicit;
    }

    if (this.hasConfiguredSensorIdOverride()) {
      this.platform.log.error(
        `[FrontGate ${this.accessory.displayName}] configured sensor IDs did not resolve; gate is unavailable`,
      );
      return undefined;
    }

    const candidates = this.findSensorCandidates();
    if (candidates.length === 0) {
      if (this.platform.shouldFallbackFrontGateSensorToControlChannel()) {
        this.platform.log.warn(
          `[FrontGate ${this.accessory.displayName}] no dedicated sensor found; using explicitly enabled control-channel fallback`,
        );
        return this.controlBaseTopic;
      }
      this.platform.log.error(
        `[FrontGate ${this.accessory.displayName}] no unambiguous gate sensor found; gate is unavailable`,
      );
      return undefined;
    }

    const winner = candidates[0];
    const tiedWinners = candidates.filter(candidate => candidate.score === winner.score);
    if (tiedWinners.length > 1) {
      const labels = tiedWinners
        .map(candidate => `${candidate.channel.deviceId}/${candidate.channel.channelId}`)
        .join(', ');
      this.platform.log.error(
        `[FrontGate ${this.accessory.displayName}] sensor pairing is ambiguous (${labels}); configure an explicit sensor`,
      );
      return undefined;
    }
    this.platform.log.info(
      `[FrontGate ${this.accessory.displayName}] resolved sensor channel ${winner.channel.channelCaption} `
      + `(${winner.channel.deviceId}/${winner.channel.channelId}) -> ${winner.baseTopic} `
      + `[${winner.reasons.join(', ')}]`,
    );
    return winner.baseTopic;
  }

  private hasConfiguredSensorIdOverride(): boolean {
    const config = this.platform.config as unknown as FrontGateConfigView;
    return this.normalizeOptionalId(config.frontGateSensorDeviceId) !== undefined
      || this.normalizeOptionalId(config.frontGateSensorChannelId) !== undefined;
  }

  private resolveSensorOverrideFromConfig(): string | undefined {
    const config = this.platform.config as unknown as FrontGateConfigView;

    if (typeof config.frontGateSensorTopic === 'string' && config.frontGateSensorTopic.trim()) {
      return this.platform.normalizeTopicBase(config.frontGateSensorTopic);
    }

    const requestedDeviceId = this.normalizeOptionalId(config.frontGateSensorDeviceId);
    const requestedChannelId = this.normalizeOptionalId(config.frontGateSensorChannelId);
    if (!requestedDeviceId && !requestedChannelId) {
      return undefined;
    }

    const matches = this.collectKnownChannels().filter(candidate => {
      if (requestedDeviceId && candidate.deviceId !== requestedDeviceId) {
        return false;
      }
      if (requestedChannelId && candidate.channelId !== requestedChannelId) {
        return false;
      }
      return true;
    });

    if (matches.length !== 1) {
      return undefined;
    }

    return this.platform.normalizeTopicBase(matches[0].topic);
  }

  private findSensorCandidates(): SensorCandidate[] {
    const channels = this.collectKnownChannels();
    const candidates: SensorCandidate[] = [];

    for (const channel of channels) {
      if (channel.channelId === this.context.channelId && channel.deviceId === this.context.deviceId) {
        continue;
      }

      const score = this.scoreSensorCandidate(channel);
      // A lone unrelated window/contact sensor is not enough evidence to pair it
      // with a gate. Explicit gate functions score 100; generic candidates must
      // also match the device or caption to cross this threshold.
      if (score.score < 85) {
        continue;
      }

      candidates.push({
        channel,
        baseTopic: this.platform.normalizeTopicBase(channel.topic),
        score: score.score,
        reasons: score.reasons,
      });
    }

    candidates.sort((left, right) => right.score - left.score);
    return candidates;
  }

  private scoreSensorCandidate(channel: SuplaChannelContext): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    const functionName = (channel.channelFunction || '').toUpperCase();
    const typeName = (channel.channelType || '').toUpperCase();

    const isGateSensorFunction = functionName === 'OPENINGSENSOR_GATE' || functionName === 'OPENINGSENSOR_GATEWAY';
    const isGenericOpeningSensor = functionName.startsWith('OPENINGSENSOR_');
    const isBinarySensor = typeName === 'BINARYSENSOR';
    const sameDevice = Boolean(channel.deviceId && channel.deviceId === this.context.deviceId);
    const captionScore = this.computeCaptionSimilarity(
      this.context.channelCaption || this.accessory.displayName,
      channel.channelCaption || '',
    );

    if (isGateSensorFunction) {
      score += 100;
      reasons.push('gate-sensor-function');
    } else if (isGenericOpeningSensor) {
      score += 70;
      reasons.push('opening-sensor-function');
    } else if (isBinarySensor) {
      if (!sameDevice && captionScore === 0) {
        return { score: 0, reasons: [] };
      }
      score += 20;
      reasons.push('binary-sensor');
    } else {
      return { score: 0, reasons: [] };
    }

    if (sameDevice) {
      score += 50;
      reasons.push('same-device');
    }

    if (captionScore > 0) {
      score += captionScore;
      reasons.push(`caption+${captionScore}`);
    }

    const controlBase = this.platform.normalizeTopicBase(this.context.topic);
    const candidateBase = this.platform.normalizeTopicBase(channel.topic);
    if (controlBase && candidateBase && controlBase !== candidateBase) {
      const controlPrefix = controlBase.replace(/\/channels\/[^/]+$/, '');
      const candidatePrefix = candidateBase.replace(/\/channels\/[^/]+$/, '');
      if (controlPrefix === candidatePrefix) {
        score += 15;
        reasons.push('same-device-topic-prefix');
      }
    }

    return { score, reasons };
  }

  private computeCaptionSimilarity(left: string, right: string): number {
    const leftTokens = this.tokenizeCaption(left);
    const rightTokens = this.tokenizeCaption(right);

    if (leftTokens.length === 0 || rightTokens.length === 0) {
      return 0;
    }

    const rightSet = new Set(rightTokens);
    let overlap = 0;
    for (const token of leftTokens) {
      if (rightSet.has(token)) {
        overlap += 1;
      }
    }

    if (overlap === 0) {
      return 0;
    }

    return Math.min(40, overlap * 10);
  }

  private tokenizeCaption(value: string): string[] {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .filter(token => !new Set([
        'gate',
        'sensor',
        'contact',
        'opening',
        'open',
        'close',
        'controller',
      ]).has(token));
  }

  private normalizeOptionalId(value: string | number | undefined): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const normalized = String(value).trim();
    return normalized || undefined;
  }

  private collectKnownChannels(): SuplaChannelContext[] {
    return this.platform.getKnownChannels();
  }
}
