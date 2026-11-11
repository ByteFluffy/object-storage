export { mergeConfig } from './core/config.js';
export { createStorage, Storage } from './core/storage.js';
export { StorageError } from './core/errors.js';
export { readSource } from './io/sources.js';
export { createWorkspace } from './io/workspace.js';

export type {
  Checksum,
  DeliveryEvidence,
  DirectUploadPlan,
  DriverCapabilities,
  FinalizeRequest,
  ObjectRef,
  ObjectStat,
  Source,
  StorageDriver,
  UploadRequest,
  UploadResult,
} from './core/contracts.js';
export type { Artifact, Workspace } from './io/workspace.js';
