// Config validation, compilation and loading. NOT IMPLEMENTED YET — on purpose.
//
// Shared by the extension AND by the config repo's compiler, so a config that
// compiles is a config the browser accepts, and a config the compiler refuses
// can never reach a browser.
//
// Contract:
//   SCHEMA                       the schema version this build speaks
//   validateConfig(raw)       -> { ok, errors: string[] }
//   compile(raw)              -> { config, errors }   ordered by specificity
//   loadConfig(chrome)        -> { config, inert, errors }

export const SCHEMA = 1;

// eslint-disable-next-line no-unused-vars
export function validateConfig(raw) {
  throw new Error('config.validateConfig: not implemented');
}

// eslint-disable-next-line no-unused-vars
export function compile(raw) {
  throw new Error('config.compile: not implemented');
}

// eslint-disable-next-line no-unused-vars
export async function loadConfig(chrome) {
  throw new Error('config.loadConfig: not implemented');
}
