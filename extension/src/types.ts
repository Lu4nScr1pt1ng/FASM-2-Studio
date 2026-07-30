export type Dialect = 'fasm2' | 'fasm1';

/** fasm2Studio.<...>CompilerPath setting key for each dialect. */
export const COMPILER_PATH_SETTING: Record<Dialect, string> = {
  fasm2: 'fasm2CompilerPath',
  fasm1: 'fasm1CompilerPath',
};

/** Human-readable name for each dialect, used in user-facing messages. */
export const DIALECT_LABEL: Record<Dialect, string> = {
  fasm2: 'fasm2/fasmg',
  fasm1: 'fasm1',
};
