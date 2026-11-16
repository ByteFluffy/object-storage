export { mergeConfig } from './core/config.js';
export { createStorage, Storage } from './core/storage.js';
export { StorageError } from './core/errors.js';
export { readSource } from './io/sources.js';
export { createWorkspace } from './io/workspace.js';

export type {
  AbortMultipartInput,
  Checksum,
  CompleteMultipartInput,
  CreateMultipartInput,
  DeliveryEvidence,
  DirectUploadPlan,
  DriverCapabilities,
  DriverPut,
  FinalizeRequest,
  ObjectRef,
  ObjectStat,
  MultipartSession,
  PutPrecondition,
  Source,
  StorageDriver,
  UploadRequest,
  UploadPartInput,
  UploadResult,
} from './core/contracts.js';
export type { Artifact, Workspace } from './io/workspace.js';
