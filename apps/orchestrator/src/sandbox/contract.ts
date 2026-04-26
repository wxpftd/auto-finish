/**
 * Provider contract test battery.
 *
 * Every implementation of `SandboxProvider` (InMemory, Daytona, Microsandbox,
 * ...) must pass these tests. Each provider's own *.test.ts file calls
 * `runProviderContract('MyProvider', () => new MyProvider())`.
 *
 * Tests use only the recognized argv set documented on `InMemoryProvider`:
 *   echo, cat, true, false, exit, sleep, /bin/sh -c, stream-lines.
 *
 * For real-world providers that don't have `stream-lines` natively, the
 * provider is expected to recognize it as a contract-test alias (e.g. by
 * shelling out to printf) — alternatively, providers can override these
 * commands by writing a tiny shim into the sandbox during `create()`.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SandboxProvider, StreamEvent } from './interface.js';

export type ProviderFactory = () => SandboxProvider | Promise<SandboxProvider>;

export function runProviderContract(
  name: string,
  makeProvider: ProviderFactory,
): void {
  describe(`SandboxProvider contract: ${name}`, () => {
    describe('lifecycle', () => {
      it('create() returns a session with a non-empty id', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          expect(typeof session.id).toBe('string');
          expect(session.id.length).toBeGreaterThan(0);
        } finally {
          await session.destroy();
        }
      });

      it('create() returns distinct ids for each session', async () => {
        const provider = await makeProvider();
        const a = await provider.create({});
        const b = await provider.create({});
        try {
          expect(a.id).not.toBe(b.id);
        } finally {
          await a.destroy();
          await b.destroy();
        }
      });

      it('destroy() is idempotent', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        await session.destroy();
        await expect(session.destroy()).resolves.toBeUndefined();
      });

      it('using a session after destroy() throws', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        await session.destroy();
        await expect(session.run(['echo', 'x'])).rejects.toThrow(/destroyed/i);
        await expect(session.readFile('/foo')).rejects.toThrow(/destroyed/i);
        await expect(
          session.writeFile('/foo', new Uint8Array([1])),
        ).rejects.toThrow(/destroyed/i);
      });
    });

    describe('run()', () => {
      it('echo returns its args on stdout with trailing newline and exit 0', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          const r = await session.run(['echo', 'hello', 'world']);
          expect(r.exit_code).toBe(0);
          expect(r.stdout).toBe('hello world\n');
          expect(r.stderr).toBe('');
        } finally {
          await session.destroy();
        }
      });

      it('non-zero exit code is returned, not thrown', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          const r = await session.run(['false']);
          expect(r.exit_code).not.toBe(0);
        } finally {
          await session.destroy();
        }
      });

      it('configurable error via /bin/sh -c surfaces stderr without throwing', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          const r = await session.run(['/bin/sh', '-c', 'boom']);
          expect(r.exit_code).not.toBe(0);
          expect(r.stderr).toContain('boom');
        } finally {
          await session.destroy();
        }
      });

      it('timeout_ms enforces a hard deadline', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          // sleep 1000ms with a 50ms deadline should reject.
          await expect(
            session.run(['sleep', '1000'], { timeout_ms: 50 }),
          ).rejects.toThrow();
        } finally {
          await session.destroy();
        }
      });
    });

    describe('file ops', () => {
      it('writeFile then readFile round-trips bytes', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          const payload = new Uint8Array([0, 1, 2, 250, 251, 252]);
          await session.writeFile('/data/blob.bin', payload);
          const out = await session.readFile('/data/blob.bin');
          expect(out).toEqual(payload);
        } finally {
          await session.destroy();
        }
      });

      it('readFile on a missing path throws', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          await expect(session.readFile('/no/such/file')).rejects.toThrow();
        } finally {
          await session.destroy();
        }
      });

      it('writeFile creates parent dirs implicitly (deep path works)', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          const deep = '/a/b/c/d/e/file.txt';
          const bytes = new TextEncoder().encode('hi');
          await session.writeFile(deep, bytes);
          const back = await session.readFile(deep);
          expect(new TextDecoder().decode(back)).toBe('hi');
        } finally {
          await session.destroy();
        }
      });

      it('cat command can read files written via writeFile', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          await session.writeFile(
            '/etc/greeting',
            new TextEncoder().encode('howdy'),
          );
          const r = await session.run(['cat', '/etc/greeting']);
          expect(r.exit_code).toBe(0);
          expect(r.stdout).toBe('howdy');
        } finally {
          await session.destroy();
        }
      });
    });

    describe('uploadFile()', () => {
      it('copies a real host file into the sandbox', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        const tmp = await fs.mkdtemp(
          path.join(os.tmpdir(), 'sandbox-contract-'),
        );
        const hostFile = path.join(tmp, 'creds.json');
        const content = '{"token":"abc"}';
        await fs.writeFile(hostFile, content, 'utf8');
        try {
          await session.uploadFile(hostFile, '/root/.claude/credentials.json');
          const back = await session.readFile(
            '/root/.claude/credentials.json',
          );
          expect(new TextDecoder().decode(back)).toBe(content);
        } finally {
          await session.destroy();
          await fs.rm(tmp, { recursive: true, force: true });
        }
      });
    });

    describe('startStream()', () => {
      it('yields stdout events then a final exit event', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          const events: StreamEvent[] = [];
          for await (const ev of session.startStream([
            'stream-lines',
            'one',
            'two',
            'three',
          ])) {
            events.push(ev);
          }
          const stdoutData = events
            .filter((e): e is { kind: 'stdout'; data: string } =>
              e.kind === 'stdout',
            )
            .map((e) => e.data)
            .join('');
          expect(stdoutData).toContain('one');
          expect(stdoutData).toContain('two');
          expect(stdoutData).toContain('three');

          const last = events[events.length - 1];
          expect(last).toBeDefined();
          expect(last?.kind).toBe('exit');
          if (last?.kind === 'exit') {
            expect(last.code).toBe(0);
          }
        } finally {
          await session.destroy();
        }
      });

      it('consumer can break early without leaking', async () => {
        const provider = await makeProvider();
        const session = await provider.create({});
        try {
          let seen = 0;
          for await (const ev of session.startStream([
            'stream-lines',
            'a',
            'b',
            'c',
            'd',
            'e',
          ])) {
            seen += 1;
            void ev;
            if (seen >= 2) break;
          }
          expect(seen).toBe(2);
          // Session must still be usable after early break.
          const r = await session.run(['echo', 'still-alive']);
          expect(r.exit_code).toBe(0);
          expect(r.stdout).toBe('still-alive\n');
        } finally {
          await session.destroy();
        }
      });
    });
  });
}
