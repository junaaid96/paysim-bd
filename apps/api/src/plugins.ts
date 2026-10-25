import { bkashPlugin } from '@paysim/gateway-bkash';
import { nagadPlugin } from '@paysim/gateway-nagad';
import { rocketPlugin } from '@paysim/gateway-rocket';
import { sslcommerzPlugin } from '@paysim/gateway-sslcommerz';
import { upayPlugin } from '@paysim/gateway-upay';
import type { GatewayPlugin } from '@paysim/core';

export function loadPlugins(): GatewayPlugin[] {
  return [sslcommerzPlugin, bkashPlugin, nagadPlugin, rocketPlugin, upayPlugin];
}

export function gatewayPrefixes(plugins: GatewayPlugin[]): string[] {
  return plugins.flatMap((plugin) => plugin.prefixes);
}
