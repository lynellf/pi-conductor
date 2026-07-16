/** Delegation-lite host helpers. */

export { buildChildPrompt, type ChildPrompt } from "./child-prompt.js";
export {
  type DelegateResult,
  type DelegateResultStatus,
  type DelegateTaskResult,
  executeDelegate,
} from "./delegate-tool.js";
export { createDelegateTool, type DelegateToolFactoryOptions } from "./delegate-tool-factory.js";
export {
  buildBranchName,
  buildWorktreePath,
  type ChildId,
  generateChildId,
  isValidTaskId,
} from "./ids.js";
export { DelegationManager } from "./manager.js";
export { runBoundedPool } from "./pool.js";
export {
  type BatchValidationResult,
  formatBatchErrors,
  type ValidatedTask,
  validateBatch,
} from "./validate-batch.js";
export {
  captureBaseCommit,
  checkPrimaryGitStatus,
  createWorktree,
  determineChildStatus,
  verifyWorktree,
  type WorktreeSetup,
} from "./worktree.js";
