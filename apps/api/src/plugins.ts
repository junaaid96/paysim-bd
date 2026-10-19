import { bkashPlugin } from '@paysim/gateway-bkash';
import { nagadPlugin } from '@paysim/gateway-nagad';
import { sslcommerzPlugin } from '@paysim/gateway-sslcommerz';
import type { GatewayPlugin } from '@paysim/core';

export function loadPlugins(): GatewayPlugin[] {
  return [sslcommerzPlugin, bkashPlugin, nagadPlugin];
}

export function gatewayPrefixes(plugins: GatewayPlugin[]): string[] {
  return plugins.flatMap((plugin) => plugin.prefixes);
}
