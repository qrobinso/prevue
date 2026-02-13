import type { PlaybackInfo } from '../types';

type ViewOwner = 'guide' | 'player';

type PlaybackInfoWithInterstitial = PlaybackInfo & { is_interstitial: boolean };

interface ActivePlaybackSession {
  owner: ViewOwner;
  channelId: number;
  itemId: string;
  info: PlaybackInfoWithInterstitial;
  positionSec: number;
  updatedAt: number;
}

interface HandoffRequest {
  from: ViewOwner;
  to: ViewOwner;
  channelId: number;
  itemId: string;
  positionSec: number;
  expiresAt: number;
}

const HANDOFF_TTL_MS = 8000;

let activeSession: ActivePlaybackSession | null = null;
let handoffRequest: HandoffRequest | null = null;

export function updateActivePlaybackSession(
  owner: ViewOwner,
  channelId: number,
  info: PlaybackInfoWithInterstitial,
  positionSec: number
): void {
  const itemId = info.program?.jellyfin_item_id;
  if (!itemId) return;
  activeSession = {
    owner,
    channelId,
    itemId,
    info,
    positionSec,
    updatedAt: Date.now(),
  };
}

export function updatePlaybackPosition(owner: ViewOwner, itemId: string, positionSec: number): void {
  if (!activeSession) return;
  if (activeSession.owner !== owner || activeSession.itemId !== itemId) return;
  activeSession.positionSec = positionSec;
  activeSession.updatedAt = Date.now();
}

export function requestPlaybackHandoff(
  from: ViewOwner,
  to: ViewOwner,
  channelId: number,
  itemId: string,
  positionSec: number
): void {
  handoffRequest = {
    from,
    to,
    channelId,
    itemId,
    positionSec,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  };
}

export function shouldPreservePlaybackOnUnmount(
  from: ViewOwner,
  channelId: number,
  itemId: string
): boolean {
  if (!handoffRequest) return false;
  if (Date.now() > handoffRequest.expiresAt) {
    handoffRequest = null;
    return false;
  }
  return (
    handoffRequest.from === from &&
    handoffRequest.channelId === channelId &&
    handoffRequest.itemId === itemId
  );
}

export function consumePlaybackHandoff(
  to: ViewOwner,
  channelId: number,
  expectedItemId: string
): { info: PlaybackInfoWithInterstitial; positionSec: number } | null {
  if (!handoffRequest || !activeSession) return null;
  if (Date.now() > handoffRequest.expiresAt) {
    handoffRequest = null;
    return null;
  }
  if (
    handoffRequest.to !== to ||
    handoffRequest.channelId !== channelId ||
    handoffRequest.itemId !== expectedItemId
  ) {
    return null;
  }
  if (
    activeSession.channelId !== channelId ||
    activeSession.itemId !== expectedItemId
  ) {
    return null;
  }

  const result = {
    info: activeSession.info,
    positionSec: handoffRequest.positionSec,
  };
  activeSession.owner = to;
  activeSession.positionSec = handoffRequest.positionSec;
  activeSession.updatedAt = Date.now();
  handoffRequest = null;
  return result;
}
