import type { Workspace } from '../../io/workspace.js';

export async function cleanWorkspace(workspace: Workspace): Promise<void> {
  await workspace.release();
}
