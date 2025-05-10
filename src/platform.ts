// eslint-disable-next-line import/no-extraneous-dependencies
import { APIEvent, Categories } from 'homebridge'; // enum
import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  WithUUID,
} from 'homebridge';

import chalk from 'chalk';
import { satisfies } from 'semver';
import { Client } from 'tplink-smarthome-api';
import type { Sysinfo } from 'tplink-smarthome-api';

import { parseConfig } from './config';
import type { TplinkSmarthomeConfig } from './config';
import Characteristics from './characteristics';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { lookup, lookupCharacteristicNameByUUID, isObjectLike } from './utils';
import type { TplinkDevice } from './utils';
import create from './homekit-device/create';
import HomekitDevice from './homekit-device';
import { Credentials } from './credentials';
import { KlapProtocol } from './klap-protocol';
import { KlapTransport } from './klap-transport';

// okay for reading json
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageConfig = require('../package.json');

export type TplinkSmarthomeAccessoryContext = {
  deviceId?: string;
};

export default class TplinkSmarthomePlatform implements DynamicPlatformPlugin {
  public readonly Service;

  public readonly Characteristic;

  public customCharacteristics: ReturnType<typeof Characteristics>;

  public config: TplinkSmarthomeConfig;

  private readonly configuredAccessories: Map<
    string,
    PlatformAccessory<TplinkSmarthomeAccessoryContext>
  > = new Map();

  private readonly homekitDevicesById: Map<string, HomekitDevice> = new Map();

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API
  ) {
    this.log.info(
      '%s v%s, node %s, homebridge v%s, api v%s',
      packageConfig.name,
      packageConfig.version,
      process.version,
      api.serverVersion,
      api.version
    );
    if (!satisfies(process.version, packageConfig.engines.node)) {
      this.log.error(
        'Error: not using minimum node version %s',
        packageConfig.engines.node
      );
    }
    if (
      api.versionGreaterOrEqual == null ||
      !api.versionGreaterOrEqual('1.3.0')
    ) {
      this.log.error(
        `homebridge-tplink-smarthome requires homebridge >= 1.3.0. Currently running: ${api.serverVersion}`
      );
      throw new Error(
        `homebridge-tplink-smarthome requires homebridge >= 1.3.0. Currently running: ${api.serverVersion}`
      );
    }

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.log.debug('config.json: %j', config);
    this.config = parseConfig(config);
    this.log.debug('config: %j', this.config);

    this.customCharacteristics = Characteristics(api.hap.Characteristic);

    const tplinkApiLogger: Logging = Object.assign(() => {}, this.log, {
      prefix: `${this.log.prefix || PLATFORM_NAME}.API`,
    });

    const client = new Client({
      logger: tplinkApiLogger,
      defaultSendOptions: this.config.defaultSendOptions,
    });

    client.on('device-new', (device: TplinkDevice) => {
      this.log.info(
        `Device First Online: ${chalk.blue(`[${device.alias}]`)} %s [%s]`,
        device.deviceType,
        device.id,
        device.host,
        device.port
      );
      this.foundDevice(device);
    });

    client.on('device-online', (device: TplinkDevice) => {
      this.log.debug(
        `Device Online: ${chalk.blue(`[${device.alias}]`)} %s [%s]`,
        device.deviceType,
        device.id,
        device.host,
        device.port
      );
      this.foundDevice(device);
    });

    client.on('device-offline', (device: TplinkDevice) => {
      const deviceAccessory = this.homekitDevicesById.get(device.id);

      if (deviceAccessory !== undefined) {
        this.log.debug(
          `Device Offline: ${chalk.blue(`[${device.alias}]`)} %s [%s]`,
          deviceAccessory.homebridgeAccessory.displayName,
          device.deviceType,
          device.id,
          device.host,
          device.port
        );
      }
    });

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.log.debug(APIEvent.DID_FINISH_LAUNCHING);

      // Start legacy discovery (port 9999)
      client.startDiscovery({
        ...this.config.discoveryOptions,
        filterCallback: (si: Sysinfo) => {
          return si.deviceId != null && si.deviceId.length > 0;
        },
      });

      // If KLAP is enabled, attempt to discover newer devices
      if (this.config.useKlap) {
        this.log.info('KLAP protocol enabled, attempting to discover newer devices');
        this.discoverKlapDevices();
      }

      const refreshEmeterForAccessories = async (
        accessories: HomekitDevice[]
      ) => {
        for (const acc of accessories) {
          const device = acc.tplinkDevice;
          if (device.supportsEmeter) {
            this.log.debug(
              `getEmeterRealtime ${chalk.blue(`[${device.alias}]`)}`
            );
            // eslint-disable-next-line no-await-in-loop
            await device.emeter.getRealtime().catch((reason) => {
              this.log.error('[%s] %s', device.alias, 'emeter.getRealtime()');
              this.log.error(reason);
            });
          }
        }
      };

      const refreshEmeter = async () => {
        this.log.debug(`${chalk.magenta('refreshEmeter()')}`);
        if (this.config.emeterPollingInterval <= 0) return;

        try {
          const deviceAccessories = this.deviceAccessoriesByHost;
          const promises: Promise<unknown>[] = [];

          for (const accForHost of deviceAccessories.values()) {
            promises.push(refreshEmeterForAccessories(accForHost));
          }
          await Promise.all(promises);
        } catch (err) {
          this.log.error(`Error in ${chalk.magenta('refreshEmeter()')}:`);
          this.log.error(String(err));
        } finally {
          this.log.debug(
            `Scheduling next run of ${chalk.magenta(
              'refreshEmeter()'
            )} in %d(ms)`,
            this.config.emeterPollingInterval
          );
          setTimeout(() => {
            refreshEmeter();
          }, this.config.emeterPollingInterval);
        }
      };

      if (this.config.emeterPollingInterval > 0) refreshEmeter();
    });

    this.api.on('shutdown', () => {
      this.log.debug('shutdown');
      client.stopDiscovery();
    });
  }

  /**
   * Discover devices using KLAP protocol (newer devices)
   */
  private async discoverKlapDevices(): Promise<void> {
    try {
      // This is a simplified approach - in a full implementation,
      // you would need to implement proper UDP discovery on port 20002
      this.log.debug('Starting KLAP device discovery...');

      // For now, we'll just log a message about the feature
      this.log.info(
        'KLAP discovery is enabled. If you have newer devices that aren\'t being found, ' +
        'make sure you\'ve entered your TP-Link cloud credentials in the config.'
      );

      // TODO: Implement proper KLAP discovery
      // This would involve:
      // 1. Sending UDP broadcast on port 20002
      // 2. Parsing responses from KLAP devices
      // 3. Creating appropriate device instances with KlapProtocol

      // For manual configuration, we can check for devices specified in config
      if (this.config.discoveryOptions.devices && this.config.discoveryOptions.devices.length) {
        this.log.info(`Checking ${this.config.discoveryOptions.devices.length} manually specified devices...`);

        const credentials = new Credentials(
          this.config.username || '',
          this.config.password || ''
        );

        for (const device of this.config.discoveryOptions.devices) {
          try {
            this.log.debug(`Attempting to connect to ${device.host} using KLAP protocol...`);

            // Create KLAP transport and protocol
            const transport = new KlapTransport(
              device.host,
              credentials,
              device.port,
              this.config.discoveryOptions.deviceOptions.defaultSendOptions.timeout
            );

            const protocol = new KlapProtocol(transport);

            // Try to get device info
            const deviceInfo = await protocol.query('get_device_info');

            if (deviceInfo && deviceInfo.get_device_info) {
              this.log.info(`Found KLAP device at ${device.host}: ${deviceInfo.get_device_info.model || 'Unknown model'}`);

              // Initialize device (simplified for now)
              // In a full implementation, you would use the device info to create the appropriate device type
              this.foundKlapDevice(device.host, deviceInfo.get_device_info, protocol);
            }
          } catch (error) {
            this.log.debug(`Failed to connect to ${device.host} with KLAP: ${error}`);
          }
        }
      }
    } catch (error) {
      this.log.error(`Error during KLAP device discovery: ${error}`);
    }
  }

  /**
   * Handle a discovered KLAP device
   */
  private foundKlapDevice(host: string, deviceInfo: any, protocol: KlapProtocol): void {
    try {
      const deviceId = deviceInfo.device_id;

      if (!deviceId) {
        this.log.error(`Missing deviceId for KLAP device: ${host}`);
        return;
      }

      if (this.homekitDevicesById.get(deviceId) !== undefined) {
        return;
      }

      this.log.info(
        `Adding KLAP device: ${deviceInfo.alias || 'Unknown'} [${deviceId}] at ${host}`
      );

      const uuid = this.api.hap.uuid.generate(deviceId);
      const accessory = this.configuredAccessories.get(uuid);

      // Create device based on type
      const deviceType = deviceInfo.device_type || '';
      let tplinkDevice;

      if (deviceType.includes('BULB')) {
        // Create a minimal bulb device object that matches the legacy API
        tplinkDevice = {
          host,
          port: 80, // KLAP uses HTTP
          deviceType: 'bulb',
          model: deviceInfo.model || 'Unknown',
          alias: deviceInfo.alias || 'Unknown',
          id: deviceId,
          mac: deviceInfo.mac || '',
          supportsBrightness: true,
          supportsColorTemperature: deviceInfo.light_state?.color_temp !== undefined,
          supportsColor: deviceInfo.light_state?.hue !== undefined,
          supportsDimmer: false,
          supportsEmeter: false,
          sysInfo: {
            light_state: deviceInfo.light_state || {},
          },
          emeter: {
            realtime: {},
          },
        };
      } else {
        // Create a minimal plug device object that matches the legacy API
        tplinkDevice = {
          host,
          port: 80, // KLAP uses HTTP
          deviceType: 'plug',
          model: deviceInfo.model || 'Unknown',
          alias: deviceInfo.alias || 'Unknown',
          id: deviceId,
          mac: deviceInfo.mac || '',
          supportsDimmer: false,
          supportsEmeter: false,
          relayState: deviceInfo.on_off === 1,
          inUse: true,
          sysInfo: {},
          emeter: {
            realtime: {},
          },
        };
      }

      // Create the device using our factory
      const device = create(this, this.config, accessory, tplinkDevice);

      // Store KLAP protocol in the device
      if (device['protocol'] === undefined) {
        device['protocol'] = protocol;
      }

      this.homekitDevicesById.set(deviceId, device);
    } catch (error) {
      this.log.error(`Error adding KLAP device ${host}: ${error}`);
    }
  }

  /**
   * Return string representation of Service/Characteristic for logging
   *
   * @internal
   */
  public lsc(
    serviceOrCharacteristic: Service | Characteristic | { UUID: string },
    characteristic?: Characteristic | { UUID: string }
  ): string {
    let serviceName: string | undefined;
    let characteristicName: string | undefined;

    if (serviceOrCharacteristic instanceof this.api.hap.Service) {
      serviceName = this.getServiceName(serviceOrCharacteristic);
    } else if (
      serviceOrCharacteristic instanceof this.api.hap.Characteristic ||
      ('UUID' in serviceOrCharacteristic &&
        typeof serviceOrCharacteristic.UUID === 'string')
    ) {
      characteristicName = this.getCharacteristicName(serviceOrCharacteristic);
    }

    if (characteristic instanceof this.api.hap.Characteristic) {
      characteristicName = this.getCharacteristicName(characteristic);
    }

    if (serviceName != null && characteristicName != null) {
      return `[${chalk.yellow(serviceName)}.${chalk.green(
        characteristicName
      )}]`;
    }
    if (serviceName !== undefined) return `[${chalk.yellow(serviceName)}]`;
    return `[${chalk.green(characteristicName)}]`;
  }

  private get deviceAccessoriesByHost(): Map<string, HomekitDevice[]> {
    const byHost: Map<string, HomekitDevice[]> = new Map();
    for (const [, tpLinkAccessory] of this.homekitDevicesById) {
      const { host } = tpLinkAccessory.tplinkDevice;
      const arr = byHost.get(host);
      if (arr != null) {
        arr.push(tpLinkAccessory);
      } else {
        byHost.set(host, [tpLinkAccessory]);
      }
    }
    return byHost;
  }

  private createHomekitDevice(
    accessory: PlatformAccessory<TplinkSmarthomeAccessoryContext> | undefined,
    tplinkDevice: TplinkDevice
  ): HomekitDevice {
    return create(this, this.config, accessory, tplinkDevice);
  }

  getCategoryName(category: Categories): string | undefined {
    // @ts-expect-error: this should work
    // eslint-disable-next-line deprecation/deprecation
    return this.api.hap.Accessory.Categories[category];
  }

  getServiceName(service: { UUID: string }): string | undefined {
    return lookup(
      this.api.hap.Service,
      (thisKeyValue, value) =>
        isObjectLike(thisKeyValue) &&
        'UUID' in thisKeyValue &&
        thisKeyValue.UUID === value,
      service.UUID
    );
  }

  getCharacteristicName(
    characteristic: WithUUID<{ name?: string; displayName?: string }>
  ): string | undefined {
    if ('name' in characteristic && characteristic.name !== undefined)
      return characteristic.name;
    if (
      'displayName' in characteristic &&
      characteristic.displayName !== undefined
    )
      return characteristic.displayName;

    if ('UUID' in characteristic) {
      return lookupCharacteristicNameByUUID(
        this.api.hap.Characteristic,
        characteristic.UUID
      );
    }
    return undefined;
  }

  /**
   * Registers a Homebridge PlatformAccessory.
   *
   * Calls {@link external:homebridge.API#registerPlatformAccessories}
   */
  registerPlatformAccessory(
    platformAccessory: PlatformAccessory<TplinkSmarthomeAccessoryContext>
  ): void {
    this.log.debug(
      `registerPlatformAccessory(${chalk.blue(
        `[${platformAccessory.displayName}]`
      )})`
    );
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      platformAccessory,
    ]);
  }

  /**
   * Function invoked when homebridge tries to restore cached accessory
   */
  configureAccessory(
    accessory: PlatformAccessory<TplinkSmarthomeAccessoryContext>
  ): void {
    this.log.info(
      `Configuring cached accessory: ${chalk.blue(
        `[${accessory.displayName}]`
      )} UUID: ${accessory.UUID} deviceId: %s `,
      accessory.context?.deviceId
    );
    this.log.debug('%O', accessory.context);

    this.configuredAccessories.set(accessory.UUID, accessory);
  }

  /**
   * Adds a new or existing real device.
   */
  private foundDevice(device: TplinkDevice): void {
    const deviceId = device.id;

    if (deviceId == null || deviceId.length === 0) {
      this.log.error('Missing deviceId: %s', device.host);
      return;
    }

    if (this.homekitDevicesById.get(deviceId) !== undefined) {
      return;
    }

    this.log.info(
      `Adding: ${chalk.blue(`[${device.alias}]`)} %s [%s]`,
      device.deviceType,
      deviceId
    );

    const uuid = this.api.hap.uuid.generate(deviceId);
    const accessory = this.configuredAccessories.get(uuid);

    this.homekitDevicesById.set(
      device.id,
      this.createHomekitDevice(accessory, device)
    );
  }
}
