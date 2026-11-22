// Error facts are deliberately limited to the local file and OS operation.
export class SettingsFailure extends Error {
  constructor(failures) { super('Settings not saved'); this.failures = failures; }
}

const fileFact = (error, path) => {
  const file = typeof error?.path === 'string' ? error.path : path;
  if (typeof error?.code === 'string' && typeof error?.syscall === 'string') return `${file ? `${file}: ` : ''}${error.code} (${error.syscall})`;
  return typeof file === 'string' ? `${file}: ${error?.name ?? 'Error'}` : null;
};

export const localCause = error => error instanceof SettingsFailure
  ? error.failures.map(({ error: each, path }) => fileFact(each, path)).filter(Boolean).join('\n') || null
  : fileFact(error);

export const serializeControlError = (action, error, messages) => {
  const message = messages[action] ?? 'Unsupported configuration operation.';
  const cause = localCause(error);
  return cause && ['default-model', 'catalog-accept', 'catalog-reject'].includes(action)
    ? cause
    : (cause ? `${message}\n${cause}` : message);
};
