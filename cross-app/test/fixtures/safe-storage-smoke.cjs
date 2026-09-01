'use strict';

const { app, safeStorage } = require('electron');

app.whenReady().then(async () => {
  const available = await safeStorage.isAsyncEncryptionAvailable();
  if (!available) {
    console.log(JSON.stringify({ available: false, roundTrip: false, ciphertextIsOpaque: false }));
    app.exit(2);
    return;
  }
  const value = `agent-harness-safe-storage-${process.pid}`;
  const encrypted = await safeStorage.encryptStringAsync(value);
  const decrypted = await safeStorage.decryptStringAsync(encrypted);
  const result = {
    available: true,
    roundTrip: decrypted.result === value,
    ciphertextIsOpaque: !encrypted.toString('utf8').includes(value),
  };
  console.log(JSON.stringify(result));
  app.exit(result.roundTrip && result.ciphertextIsOpaque ? 0 : 1);
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
});
