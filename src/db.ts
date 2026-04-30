// Cross-runtime SQLite shim.
//
// Bun:    uses built-in `bun:sqlite` (no native dep, ships with Bun)
// Node:   uses `better-sqlite3` (npm dep with prebuilt binaries)
//
// Both expose the same minimal API our code uses. Generic typing is dropped
// at this layer; call sites cast result rows to their expected shape via
// the `as` operator.

import { createRequire } from "node:module";

const isBun =
  typeof process !== "undefined" &&
  (process.versions as Record<string, string | undefined>)?.bun !== undefined;

const requireFromHere = createRequire(import.meta.url);

type Args = readonly unknown[];

export interface Statement {
  run(...args: Args): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(...args: Args): T | undefined;
  all<T = unknown>(...args: Args): T[];
}

export interface DatabaseHandle {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

export interface DatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

const Ctor: new (path: string, opts?: DatabaseOptions) => DatabaseHandle = isBun
  ? requireFromHere("bun:sqlite").Database
  : requireFromHere("better-sqlite3");

export class Database implements DatabaseHandle {
  private inner: DatabaseHandle;

  constructor(path: string, opts: DatabaseOptions = {}) {
    if (isBun) {
      // bun:sqlite needs explicit create:true for writable mode, and refuses
      // both flags simultaneously. Map our options to its shape.
      const bunOpts = opts.readonly
        ? { readonly: true }
        : { create: true, readwrite: true };
      this.inner = new Ctor(path, bunOpts as DatabaseOptions);
    } else {
      this.inner = new Ctor(path, opts);
    }
  }

  prepare(sql: string): Statement {
    return this.inner.prepare(sql);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  close(): void {
    this.inner.close();
  }
}
