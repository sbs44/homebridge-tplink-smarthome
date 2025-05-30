// eslint-disable-next-line import/no-extraneous-dependencies
import { PlatformAccessoryEvent } from 'homebridge'; // enum
import type {
  Categories,
  Characteristic,
  CharacteristicValue,
  HapStatusError,
  Logger,
  Nullable,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';

import chalk from 'chalk';

import AccessoryInformation from '../accessory-information';
import type { TplinkSmarthomeConfig } from '../config';
import type TplinkSmarthomePlatform from '../platform';
import type { TplinkSmarthomeAccessoryContext } from '../platform';
import type { TplinkDevice } from '../utils';
import { prefixLogger } from '../utils';
import { KlapProtocol } from '../klap-protocol';

export default abstract class HomekitDevice {
  protected protocol?: KlapProtocol;
  readonly log: Logger;

  homebridgeAccessory: PlatformAccessory<TplinkSmarthomeAccessoryContext>;

  private lsc: (
    serviceOrCharacteristic: Service | Characteristic | { UUID: string },
    characteristic?: Characteristic | { UUID: string }
  ) => string;

  /**
   * Creates an instance of HomeKitDevice.
   */
  constructor(
    readonly platform: TplinkSmarthomePlatform,
    readonly config: TplinkSmarthomeConfig,
    homebridgeAccessory:
      | PlatformAccessory<TplinkSmarthomeAccessoryContext>
      | undefined,
    readonly tplinkDevice: TplinkDevice,
    readonly category: Categories,
    protocol?: KlapProtocol
  ) {
    this.protocol = protocol;
    this.log = prefixLogger(
      platform.log,
      () => `${chalk.blue(`[${this.name}]`)}`
    );

    this.lsc = this.platform.lsc.bind(this.platform);

    const categoryName = platform.getCategoryName(category) ?? '';

    if (homebridgeAccessory == null) {
      const uuid = platform.api.hap.uuid.generate(this.id);

      this.log.debug(
        `Creating new Accessory [${this.id}] [${uuid}] category: ${categoryName}`
      );

      // eslint-disable-next-line new-cap
      this.homebridgeAccessory = new platform.api.platformAccessory(
        this.name,
        uuid,
        category
      );

      this.homebridgeAccessory.context.deviceId = this.id;
      this.platform.registerPlatformAccessory(this.homebridgeAccessory);
    } else {
      this.homebridgeAccessory = homebridgeAccessory;

      this.log.debug(
        `Existing Accessory found [${homebridgeAccessory.context.deviceId}] [${homebridgeAccessory.UUID}] category: ${categoryName}`
      );
      this.homebridgeAccessory.displayName = this.name;
      if (this.homebridgeAccessory.category !== category) {
        this.log.warn(
          `Correcting Accessory Category from: ${platform.getCategoryName(
            this.homebridgeAccessory.category
          )} to: ${categoryName}`
        );
        this.homebridgeAccessory.category = category;
      }
      this.homebridgeAccessory.context.deviceId = this.id;
      this.platform.api.updatePlatformAccessories([this.homebridgeAccessory]);
    }

    const accInfo = AccessoryInformation(platform.api.hap)(
      this.homebridgeAccessory,
      this
    );
    if (accInfo == null) {
      this.log.error('Could not retrieve default AccessoryInformation');
    }

    // Remove Old Services
    this.homebridgeAccessory.services.forEach((service) => {
      if (service instanceof platform.Service.AccessoryInformation) return;
      if (service instanceof platform.Service.Lightbulb) return;
      if (service instanceof platform.Service.Outlet) return;
      if (service instanceof platform.Service.Switch) return;
      this.log.warn(
        `Removing stale Service: ${this.lsc(service)} uuid:[%s] subtype:[%s]`,
        service.UUID,
        service.subtype || ''
      );
      this.homebridgeAccessory.removeService(service);
    });

    this.homebridgeAccessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.identify();
    });
  }

  get id(): string {
    return this.tplinkDevice.id;
  }

  get name(): string {
    return this.tplinkDevice.alias;
  }

  // eslint-disable-next-line class-methods-use-this
  get manufacturer(): string {
    return 'TP-Link';
  }

  get model(): string {
    return this.tplinkDevice.model;
  }

  get serialNumber(): string {
    return `${this.tplinkDevice.mac} ${this.tplinkDevice.id}`;
  }

  get firmwareRevision(): string {
    return this.tplinkDevice.softwareVersion;
  }

  get hardwareRevision(): string {
    return this.tplinkDevice.hardwareVersion;
  }

  abstract identify(): void;

  updateValue(
    service: Service,
    characteristic: Characteristic,
    value: Nullable<CharacteristicValue> | Error | HapStatusError
  ) {
    this.log.debug(`Updating ${this.lsc(service, characteristic)} ${value}`);
    characteristic.updateValue(value);
  }

  addService(
    serviceConstructor:
      | typeof this.platform.Service.Outlet
      | typeof this.platform.Service.Lightbulb, // WithUUID<Service | typeof Service>,
    name: string
  ) {
    const serviceName = this.platform.getServiceName(serviceConstructor);
    this.log.debug(`Creating new ${serviceName} Service`);
    return this.homebridgeAccessory.addService(serviceConstructor, name);
  }

  protected logRejection(reason: unknown): void {
    this.log.error(JSON.stringify(reason));
  }

  protected async sendCommand(command: string | Record<string, any>): Promise<any> {
    // If we have a KLAP protocol, use it
    if (this.protocol) {
      return await this.protocol.query(command);
    }

    // Otherwise use the legacy method
    // Convert to proper command format if necessary
    let finalCommand = command;
    if (typeof command === 'string') {
      finalCommand = { system: { [command]: {} } };
    }

    // Use the existing method from tplinkDevice
    return await this.tplinkDevice.send(finalCommand);
  }

  protected removeServiceIfExists(service: WithUUID<typeof Service>) {
    const foundService = this.homebridgeAccessory.getService(service);
    if (foundService != null) {
      this.log.warn(
        `Removing stale Service: ${this.lsc(service, foundService)} uuid:[%s]`,
        foundService.UUID
      );

      this.homebridgeAccessory.removeService(foundService);
    }
  }

  protected removeCharacteristicIfExists(
    service: Service,
    characteristic: WithUUID<new () => Characteristic>
  ) {
    // testCharacteristic parameter has an incorrect type
    if (
      service.testCharacteristic(
        characteristic as unknown as WithUUID<typeof Characteristic>
      )
    ) {
      const characteristicToRemove = service.getCharacteristic(characteristic);
      this.log.warn(
        `Removing stale Characteristic: ${this.lsc(
          service,
          characteristicToRemove
        )} uuid:[%s]`,
        characteristicToRemove.UUID
      );

      service.removeCharacteristic(characteristicToRemove);
    }
  }
}
