import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'esbuild';

/** Keep the native image engine outside the bundle and ship its installed runtime beside it. */
export function objectStorageImagePlugin(): Plugin {
  return {
    name: 'object-storage-image',
    setup(build) {
      const options = build.initialOptions;
      if (options.write === false || (!options.outfile && !options.outdir)) {
        throw new Error('Image runtime packaging requires outfile or outdir and write enabled');
      }
      options.external = [...(options.external ?? []), 'sharp'];
      const destination = resolve(options.absWorkingDir ?? process.cwd(), options.outdir ?? dirname(options.outfile!));
      build.onEnd(async result => {
        if (result.errors.length === 0) await copyImageRuntime(destination);
      });
    },
  };
}

async function copyImageRuntime(destination: string): Promise<void> {
  const copied = new Set<string>();
  async function copyPackage(name: string, resolver: NodeJS.Require, optional = false): Promise<void> {
    let manifest: string | undefined;
    for (const directory of resolver.resolve.paths(name) ?? []) {
      try {
        manifest = await realpath(join(directory, name, 'package.json'));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!manifest) {
      if (optional) return;
      throw new Error(`Missing image runtime dependency: ${name}`);
    }
    if (copied.has(name)) return;
    copied.add(name);
    const metadata = JSON.parse(await readFile(manifest, 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const target = join(destination, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await cp(dirname(manifest), target, { recursive: true, dereference: true });
    const local = createRequire(manifest);
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyPackage(dependency, local);
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) await copyPackage(dependency, local, true);
  }
  await copyPackage('sharp', createRequire(import.meta.url));
}
