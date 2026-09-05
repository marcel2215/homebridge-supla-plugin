import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { IPublishPacket } from 'mqtt';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';
import { GateMqttTransport } from '../Heplers/GateMqttTransport';
import { ContactMetadata, DoorTargetState, FrontGateFsm, FrontGateSnapshot, gateClock } from './FrontGateFsm';
import { NativeGateObserver } from './GateObservationSource';

export function parseGateBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case 'true': case '1': case 'on': case 'yes': return true;
    case 'false': case '0': case 'off': case 'no': return false;
    default: return undefined;
  }
}

export class GateAccessory {
  private readonly service: Service;
  private readonly fsm: FrontGateFsm;
  private transport?: GateMqttTransport;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private pendingContact?: boolean;
  private lastContact?: boolean;
  private lastLocalAttemptAt = -Infinity;
  private unsubscribe?: () => void;
  private reportingImmediate?: ReturnType<typeof setImmediate>;
  private disposed = false;

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
    const controlBase = this.platform.normalizeTopicBase(context.topic);
    const config = this.platform.getFrontGateConfig(context);
    delete this.accessory.context.frontGateFsm;
    this.fsm = new FrontGateFsm({
      pulseMotor: () => {
        this.lastLocalAttemptAt = gateClock.now();
        return this.transport!.publish(this.accessory.UUID);
      },
      publishSnapshot: snapshot => this.applySnapshot(snapshot),
      log: {
        debug: message => this.platform.log.debug(`[FrontGate ${context.deviceId}/${context.channelId}] ${message}`),
        info: message => this.platform.log.info(`[FrontGate ${context.deviceId}/${context.channelId}] ${message}`),
        warn: message => this.platform.log.warn(`[FrontGate ${context.deviceId}/${context.channelId}] ${message}`),
      },
    }, config.timings);
    this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(this.handleCurrentDoorStateGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onGet(this.handleTargetDoorStateGet.bind(this))
      .onSet(this.handleTargetDoorStateSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.ObstructionDetected).onGet(() => false);
    this.platform.registerOwnerCleanup(this.accessory.UUID, () => {
      this.disposed = true;
      this.clearDebounce();
      if (this.reportingImmediate) {
        clearImmediate(this.reportingImmediate);
      }
      this.fsm.dispose();
      this.unsubscribe?.();
    });
    if (config.error || !config.sensorBaseTopic) {
      this.platform.log.warn(`[FrontGate ${accessory.displayName}] ${config.error ?? 'Missing closed sensor mapping.'}`);
      return;
    }
    const sensorBase = config.sensorBaseTopic;
    this.transport = this.platform.getGateMqttTransport();
    if (!this.transport.noLocal) {
      this.platform.log.warn(
        `[FrontGate ${accessory.displayName}] MQTT 3.1.1 command echoes have ambiguous origin and cancel pending plans.`,
      );
    }
    const observer = config.observationTopic ? new NativeGateObserver(
      context.deviceId, context.channelId,
      () => this.fsm.handleCommandIntent('external', 'native-device-accepted'),
      reason => this.fsm.handleObservationGap(reason),
    ) : undefined;
    if (observer) {
      this.platform.log.info(`[FrontGate ${accessory.displayName}] read-only native observer enabled; coverage=${observer.coverage}`);
    }
    let transportEpoch = -1;
    this.unsubscribe = this.transport.register(
      accessory.UUID, controlBase, sensorBase, config.observationTopic,
      (topic, message, packet) => {
        if (this.disposed) {
          return;
        }
        if (topic === config.observationTopic) {
          observer?.receive(message, Boolean(packet.retain));
        } else if (topic === `${controlBase}/execute_action`) {
          if (packet.retain) {
            return;
          }
          const action = message.toString().trim().toLowerCase();
          if (['open_close', 'open', 'close', 'stop'].includes(action)) {
            const couldBeOwn = !this.transport!.noLocal && action === 'open_close'
              && gateClock.now() - this.lastLocalAttemptAt <= config.timings.publishTimeoutMs + config.timings.actuationDelayMs + 2000;
            this.fsm.handleCommandIntent(couldBeOwn ? 'ambiguous' : 'external', `mqtt-${action}`);
          }
        } else if (topic === `${sensorBase}/state/hi`) {
          const value = parseGateBoolean(message.toString());
          if (value === undefined) {
            this.clearDebounce();
            this.lastContact = undefined;
            this.fsm.handleInvalidContact();
          } else {
            this.observeContact(config.sensorInverted ? !value : value, packet, config.timings.sensorDebounceMs);
          }
        } else {
          const connected = parseGateBoolean(message.toString()) === true;
          if (!connected) {
            this.clearDebounce();
            this.lastContact = undefined;
          }
          if (topic === `${controlBase}/state/connected`) {
            this.fsm.handleControlConnectedChange(connected);
          } else {
            this.fsm.handleSensorConnectedChange(connected);
          }
        }
      },
      (healthy, epoch) => {
        const changedEpoch = epoch !== transportEpoch;
        if (!healthy) {
          this.clearDebounce();
          this.lastContact = undefined;
          if (transportEpoch >= 0 && changedEpoch) {
            observer?.disconnected();
          }
        }
        transportEpoch = epoch;
        this.fsm.handleTransportConnectedChange(healthy, changedEpoch);
      },
    );
  }

  async handleCurrentDoorStateGet(): Promise<CharacteristicValue> {
    const snapshot = this.fsm.getSnapshot();
    if (!snapshot.available || snapshot.currentDoorState === undefined) {
      throw this.createCommunicationError();
    }
    return snapshot.currentDoorState;
  }

  async handleTargetDoorStateGet(): Promise<CharacteristicValue> {
    const snapshot = this.fsm.getSnapshot();
    if (!snapshot.available || snapshot.targetDoorState === undefined) {
      throw this.createCommunicationError();
    }
    return snapshot.targetDoorState;
  }

  async handleTargetDoorStateSet(value: CharacteristicValue): Promise<void> {
    if (this.pendingContact !== undefined || (value !== DoorTargetState.OPEN && value !== DoorTargetState.CLOSED)) {
      throw this.createCommunicationError();
    }
    try {
      await this.fsm.requestHomeKitTarget(value === DoorTargetState.OPEN ? 'open' : 'closed');
    } catch (error) {
      this.platform.log.warn(`Gate ${this.accessory.displayName} command rejected: ${(error as Error).message}`);
      throw this.createCommunicationError();
    } finally {
      // HAP stores the written value after onSet resolves. Restore any synchronous terminal result afterwards.
      if (this.reportingImmediate) {
        clearImmediate(this.reportingImmediate);
      }
      this.reportingImmediate = setImmediate(() => {
        this.reportingImmediate = undefined;
        this.applySnapshot(this.fsm.getSnapshot());
      });
    }
  }

  private observeContact(closed: boolean, packet: IPublishPacket, debounceMs: number): void {
    const metadata: ContactMetadata = {
      retained: Boolean(packet.retain), receivedAt: gateClock.now(), epoch: this.fsm.getSnapshot().observationEpoch,
    };
    if (metadata.retained && this.fsm.getSnapshot().activeRequest) {
      return;
    }
    if (this.pendingContact === closed) {
      return;
    }
    this.clearDebounce();
    if (closed === this.lastContact || debounceMs === 0) {
      this.lastContact = closed;
      this.fsm.handleClosedSensorChange(closed, metadata);
      return;
    }
    if (this.lastContact !== undefined && !metadata.retained) {
      this.fsm.handleContactTransition();
    }
    this.pendingContact = closed;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.pendingContact = undefined;
      this.lastContact = closed;
      if (!this.disposed) {
        this.fsm.handleClosedSensorChange(closed, metadata);
      }
    }, debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.pendingContact = undefined;
  }

  private applySnapshot(snapshot: FrontGateSnapshot): void {
    if (this.disposed) {
      return;
    }
    // Reporting never invokes the target SET handler. STOPPED also represents unknown motion.
    this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, false);
    if (!snapshot.available || snapshot.currentDoorState === undefined || snapshot.targetDoorState === undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, this.createCommunicationError());
      this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, this.createCommunicationError());
      return;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, snapshot.currentDoorState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, snapshot.targetDoorState);
  }

  private createCommunicationError(): Error {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
