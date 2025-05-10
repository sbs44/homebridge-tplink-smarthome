import type { PlatformAccessory } from 'homebridge';

import type TplinkSmarthomePlatform from '../platform';
import type { TplinkSmarthomeAccessoryContext } from '../platform';
import type { TplinkDevice } from '../utils';

import HomekitDevice from '.';
import HomeKitDeviceBulb from './bulb';
import HomeKitDevicePlug from './plug';
import { TplinkSmarthomeConfig } from '../config';
import { Credentials } from '../credentials';
import { KlapProtocol } from '../klap-protocol';
import { KlapTransport } from '../klap-transport';

/**
 * Factory method to create a HomeKitDeviceBulb or HomeKitDevicePlug.
 */
export default function create(
  platform: TplinkSmarthomePlatform,
  config: TplinkSmarthomeConfig,
  homebridgeAccessory:
    | PlatformAccessory<TplinkSmarthomeAccessoryContext>
    | undefined,
  tplinkDevice: TplinkDevice
): HomekitDevice {
  // Create a device-specific protocol if needed
  let protocol = null;

  // Check if device should use KLAP protocol
  if (config.useKlap && (config.username || config.password)) {
    const credentials = new Credentials(
      config.username || '',
      config.password || ''
    );

    // Create KLAP transport and protocol
    const transport = new KlapTransport(
      tplinkDevice.host,
      credentials,
      undefined, // Use default port
      config.timeout * 1000 // Convert seconds to milliseconds
    );

    protocol = new KlapProtocol(transport);
  }

  if (tplinkDevice.deviceType === 'bulb') {
    return new HomeKitDeviceBulb(
      platform,
      config,
      homebridgeAccessory,
      tplinkDevice,
      protocol
    );
  }

  return new HomeKitDevicePlug(
    platform,
    config,
    homebridgeAccessory,
    tplinkDevice,
    protocol
  );
}