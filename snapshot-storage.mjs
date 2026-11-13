// Single-writer atomic snapshots for CFS/NFS. SQLite WAL must stay on local disks.
// The container entrypoint holds an OS flock for this store's entire lifetime.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function openSnapshotStorage(directory) {
  const path = join(directory, 'moon-table.snapshot.json');
  let state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { format: 1, rooms: {}, matches: {}, seats: {} };
  if (state.format !== 1 || !state.rooms || !state.matches || !state.seats) throw new Error('持久化快照格式错误，请从备份恢复。');
  const copy = value => value == null ? value : structuredClone(value);
  const allowed = (record, device, admin) => admin || (device && record.players.some(p => state.seats[p.id] === device));
  function persist(next) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next), 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      // Same-directory atomic replacement: readers see the old or the complete new snapshot.
      renameSync(temporary, path);
      state = next;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  if (!existsSync(path)) persist(state);
  return {
    load(id) { return copy(state.rooms[id] ?? null); },
    save(room, archive) {
      const next = structuredClone(state);
      next.rooms[room.id] = room;
      for (const seat of room.seats) next.seats[seat.id] = seat.device;
      if (archive && !next.matches[archive.id]) next.matches[archive.id] = archive;
      persist(next);
    },
    list(device, admin, offset) {
      const sorted = Object.values(state.matches).filter(r => allowed(r, device, admin))
        .sort((a, b) => b.endedAt - a.endedAt || a.id.localeCompare(b.id));
      const rows = sorted.slice(offset, offset + 25).map(r => ({ id:r.id, room:r.room, type:r.type,
        started:r.startedAt, ended:r.endedAt, winner:r.outcome.winner }));
      return { rows, more: sorted.length > offset + 25 };
    },
    match(id, device, admin) {
      const record = state.matches[id];
      return record && allowed(record, device, admin) ? copy(record) : null;
    },
    health() { if (existsSync(path)) JSON.parse(readFileSync(path, 'utf8')); },
    close() {}
  };
}
