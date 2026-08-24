import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.self.agentharness',
  appName: 'Agent Harness',
  webDir: 'dist',
  server: {
    // 生产移动端只允许 HTTPS 宿主；不为局域网调试永久打开全应用明文流量。
    androidScheme: 'https',
    cleartext: false,
  },
};

export default config;
