import { advanceRoom, type LabRoom } from './planning.js';

export function samePreviewSource(a: LabRoom | undefined, b: LabRoom) {
  return a?.state === b.state && a.scheduled === b.scheduled &&
    a.scheduledOrders === b.scheduledOrders && a.agendaOrder === b.agendaOrder;
}

/** Checkpoints belong exclusively to a private prediction branch. advanceRoom
 * clones its input; keeping an earlier checkpoint never changes its timeline. */
export function createRoomPreviewSession(initial: LabRoom) {
  const checkpoints = new Map<number, LabRoom>();
  return (targetTick: number) => {
    if (!Number.isInteger(targetTick) || targetTick < initial.state.economy.tick ||
      targetTick - initial.state.economy.tick > 1440) throw Error('Invalid forecast horizon');
    let base = initial;
    for (const [tick, checkpoint] of checkpoints)
      if (tick <= targetTick && checkpoint.state.economy.tick > base.state.economy.tick) base = checkpoint;
    const future = base === initial || base.state.economy.tick < targetTick ? advanceRoom(base, targetTick, true) : base;
    checkpoints.delete(targetTick);
    checkpoints.set(targetTick, future);
    if (checkpoints.size > 12) checkpoints.delete(checkpoints.keys().next().value!);
    return future;
  };
}

/** Omniscient debug previews have their own cache, never shared with players. */
export function createRoomPreviewCache() {
  let source: LabRoom | undefined;
  let session: ReturnType<typeof createRoomPreviewSession> | undefined;
  return (room: LabRoom, targetTick: number) => {
    if (!samePreviewSource(source, room)) {
      source = { ...room };
      session = createRoomPreviewSession(room);
    }
    return session!(targetTick);
  };
}
