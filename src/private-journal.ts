import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export async function checkPrivateDirectory(root: string): Promise<void> {
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid()) ||
    (await realpath(root)) !== root
  )
    throw new Error("Journal requires a private canonical directory");
}

/** Publish bytes once. A successfully returned call has synced both the
 * inode and its directory entry. An existing filename is never replaced. */
export async function publishPrivateFile(
  root: string,
  file: string,
  data: string,
): Promise<void> {
  const temporary = join(root, `.event-${randomUUID()}`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, join(root, file));
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export class PrivateJournal<E> {
  readonly #root: string;
  readonly #id: string;
  readonly #decode: (value: unknown) => E;
  readonly #limit: number;

  constructor(
    root: string,
    id: string,
    decode: (value: unknown) => E,
    limit: number,
  ) {
    if (!isAbsolute(root) || !uuidPattern.test(id))
      throw new Error("Invalid journal identity");
    this.#root = root;
    this.#id = id;
    this.#decode = decode;
    this.#limit = limit;
  }

  #name(sequence: number) {
    return `${this.#id}.${sequence}.json`;
  }

  async read(): Promise<E[]> {
    await checkPrivateDirectory(this.#root);
    const events: E[] = [];
    for (let index = 1; index <= this.#limit + 1; index++) {
      try {
        const bytes = await readFile(join(this.#root, this.#name(index)));
        if (bytes.length > 4096 || index > this.#limit)
          throw new Error("Journal limit exceeded");
        events.push(this.#decode(JSON.parse(bytes.toString("utf8"))));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return events;
        throw new Error("Journal could not be read");
      }
    }
    throw new Error("Journal limit exceeded");
  }

  async append(priorCount: number, event: E): Promise<void> {
    if (
      !Number.isInteger(priorCount) ||
      priorCount < 0 ||
      priorCount >= this.#limit
    )
      throw new Error("Invalid journal sequence");
    await checkPrivateDirectory(this.#root);
    const data = JSON.stringify(this.#decode(event));
    if (Buffer.byteLength(data) > 4096)
      throw new Error("Journal event exceeds limit");
    try {
      await publishPrivateFile(this.#root, this.#name(priorCount + 1), data);
    } catch {
      throw new Error("Journal event could not be committed");
    }
  }
}
