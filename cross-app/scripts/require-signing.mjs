const hasAny = (...names) => names.some((name) => Boolean(process.env[name]?.trim()));

if (process.platform === 'win32' && !hasAny('CSC_LINK', 'WIN_CSC_LINK', 'CSC_NAME')) {
  throw new Error(
    'Refusing a production Windows installer without signing credentials. ' +
    'Set CSC_LINK/WIN_CSC_LINK/CSC_NAME, or use desktop:dist:unsigned only for local testing.',
  );
}
if (process.platform === 'darwin' && !hasAny('CSC_LINK', 'CSC_NAME')) {
  throw new Error(
    'Refusing a production macOS image without signing credentials. ' +
    'Set CSC_LINK/CSC_NAME, or use desktop:dist:unsigned only for local testing.',
  );
}
