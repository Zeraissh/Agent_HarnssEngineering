'use strict';

const { isIP } = require('node:net');

/** URL.hostname 可能给 IPv6 保留方括号；只接受精确 localhost、::1 或 127/8 IP。 */
function isLoopbackHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.split('.')[0] === '127';
}

module.exports = { isLoopbackHostname };
