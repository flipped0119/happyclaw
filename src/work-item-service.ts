/**
 * Team mode (团队模式): the operations REST and the host runtime share.
 *
 * Validation, the state machine and the side effects (creating and stopping
 * worker sessions, delivering inputs, posting replies) live here, so the Web
 * and the router's tools change work items the same way. Callers check
 * workspace access first; these functions check the rest.
 *
 * The bodies are filled in by the host-core change; the signatures are the
 * contract the REST routes are written against.
 */
import type { TeamMount } from './work-item-store.js';
import type { WorkEvent } from './work-item-store.js';
import type {
  TeamSettings,
  WorkDecision,
  WorkDecisionKind,
  WorkItemStatus,
  WorkItemView,
} from './work-items.js';

export interface WorkItemActor {
  userId: string;
  isAdmin: boolean;
}

/** Thrown for a refused request; REST maps `status` to the HTTP status. */
export class WorkItemError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'WorkItemError';
  }
}

export interface TeamMountView {
  channelJid: string;
  channelName: string | null;
  /** False when the mount cannot run team mode, with the reason. */
  eligible: boolean;
  ineligibleReason: string | null;
  settings: TeamSettings;
  routerAgentId: string | null;
}

export interface WorkItemDetail {
  item: WorkItemView;
  events: WorkEvent[];
  subscriptions: { channelJid: string; subKey: string }[];
}

function notImplemented(): never {
  throw new Error('work-item-service: not implemented');
}

/** The workspace's group mounts and their team settings. */
export function listTeamMountViews(_workspaceJid: string): TeamMountView[] {
  return notImplemented();
}

/**
 * Save a mount's team settings. Bumps the version, creates the router
 * session on first enable, and stops routing through it when disabled.
 * Refuses a mount that is not an eligible Feishu group of this workspace.
 */
export async function saveTeamMountSettings(
  _workspaceJid: string,
  _channelJid: string,
  _settings: Omit<TeamSettings, 'version'>,
  _actor: WorkItemActor,
): Promise<TeamMount> {
  return notImplemented();
}

export function listWorkItemViews(
  _workspaceJid: string,
  _options?: { status?: WorkItemStatus; limit?: number },
): WorkItemView[] {
  return notImplemented();
}

export function getWorkItemDetail(_id: string): WorkItemDetail | undefined {
  return notImplemented();
}

/** End an item as stopped by a person; interrupts its worker. */
export async function stopWorkItem(
  _id: string,
  _actor: WorkItemActor,
): Promise<WorkItemView> {
  return notImplemented();
}

/** Allow edits on an item that started read-only, and tell its worker. */
export async function approveWorkItem(
  _id: string,
  _actor: WorkItemActor,
): Promise<WorkItemView> {
  return notImplemented();
}

export function listWorkDecisionsForWorkspace(
  _workspaceJid: string,
  _options?: { kind?: WorkDecisionKind; limit?: number },
): WorkDecision[] {
  return notImplemented();
}
