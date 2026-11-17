export { mergeConfig } from './core/config.js';
export { createStorage, Storage } from './core/storage.js';
export { StorageError } from './core/errors.js';
export { readSource } from './io/sources.js';
export { fingerprintSource } from './io/hash.js';
export { createWorkspace } from './io/workspace.js';

export type {
  AbortMultipartInput,
  Checksum,
  CompleteMultipartInput,
  CreateMultipartInput,
  DeliveryEvidence,
  DirectAbortPlan,
  DirectUploadPlan,
  DriverCapabilities,
  DriverPut,
  FinalizeRequest,
  ObjectRef,
  ObjectOperationOptions,
  ObjectStat,
  OpenReadResult,
  MultipartSession,
  PutPrecondition,
  PresignAbortMultipartInput,
  ReadOptions,
  Source,
  StorageDriver,
  UploadRequest,
  UploadPartInput,
  UploadResult,
} from './core/contracts.js';
export type { Artifact, Workspace } from './io/workspace.js';
