import { lstat, readdir, statfs } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { DiskEntry, DiskPayload } from "@shared/data";

/**
 * Disk usage of the home folder, two levels deep (what the sunburst draws): a full walk with a few
 * file-system calls in flight at once. Symlinks and junctions are skipped, unreadable folders ignored.
 * Partial results are published while it runs, then it rescans every RESCAN_MS.
 */

const TOP = 10;
const PARALLEL = 32;
const PROGRESS_MS = 1500;
const RESCAN_MS = 10 * 60 * 1000;

interface Node {
  name: string;
  bytes: number;
  dir: boolean;
  kids?: Map<string, Node>;
}

function top(nodes: Iterable<Node>, withKids: boolean): DiskEntry[] {
  return [...nodes]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP)
    .map((n) => {
      const e: DiskEntry = { name: n.name, bytes: n.bytes, dir: n.dir };
      if (withKids && n.kids?.size) e.children = top(n.kids.values(), false);
      return e;
    });
}

export function startDisk(publish: (p: DiskPayload) => void): () => void {
  const root = os.homedir();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function scan(): Promise<void> {
    const entries = new Map<string, Node>();
    let bytes = 0;
    let files = 0;
    let active = 0;
    const waiting: Array<() => void> = [];
    const limit = async <T>(fn: () => Promise<T>): Promise<T> => {
      while (active >= PARALLEL)
        await new Promise<void>((r) => waiting.push(r));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        waiting.shift()?.();
      }
    };

    let volume: { totalBytes: number; freeBytes: number } | undefined;
    try {
      const s = await statfs(root);
      volume = {
        totalBytes: s.blocks * s.bsize,
        freeBytes: s.bavail * s.bsize,
      };
    } catch {
      volume = undefined;
    }

    const snapshot = (scanning: boolean): DiskPayload => ({
      available: true,
      root,
      scanning,
      bytes,
      files,
      scannedAt: Date.now(),
      ...(volume && { volume }),
      entries: top(entries.values(), true),
    });

    /** `first`: the home-level entry this folder belongs to, `second`: the one below it. */
    async function walk(
      dir: string,
      first?: Node,
      second?: Node,
    ): Promise<void> {
      if (stopped) return;
      let list;
      try {
        list = await limit(() => readdir(dir, { withFileTypes: true }));
      } catch {
        return;
      }
      const pending: Promise<void>[] = [];
      for (const e of list) {
        if (e.isSymbolicLink() || !(e.isDirectory() || e.isFile())) continue;
        let a = first;
        let b = second;
        if (!a) {
          a = { name: e.name, bytes: 0, dir: e.isDirectory(), kids: new Map() };
          entries.set(e.name, a);
        } else if (!b) {
          b = { name: e.name, bytes: 0, dir: e.isDirectory() };
          a.kids!.set(e.name, b);
        }
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          pending.push(walk(path, a, b));
        } else {
          const n1 = a;
          const n2 = b;
          pending.push(
            limit(() => lstat(path)).then(
              (st) => {
                files++;
                bytes += st.size;
                n1.bytes += st.size;
                if (n2) n2.bytes += st.size;
              },
              () => {},
            ),
          );
        }
      }
      await Promise.all(pending);
    }

    const progress = setInterval(() => publish(snapshot(true)), PROGRESS_MS);
    publish(snapshot(true));
    try {
      await walk(root);
    } finally {
      clearInterval(progress);
    }
    if (stopped) return;
    publish(snapshot(false));
    timer = setTimeout(() => void run(), RESCAN_MS);
  }

  async function run(): Promise<void> {
    try {
      await scan();
    } catch (err) {
      if (!stopped)
        publish({
          available: false,
          reason: `Disk scan failed (${(err as Error).message}).`,
        });
    }
  }

  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
