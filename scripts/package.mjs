import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';

const root = resolve('.');
const outputDirectory = join(root, 'release');
const manifestName = '项目文件清单.json';
await mkdir(outputDirectory, { recursive: true });
const excluded = new Set([
  'node_modules',
  '.wrangler',
  '.dev.vars',
  '.git',
  'test-results',
  'playwright-report',
  '.test-runtime',
  'release',
]);
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      excluded.has(entry.name) ||
      (directory === root && entry.name === manifestName) ||
      entry.name.startsWith('.env') ||
      entry.name.endsWith('.log') ||
      (entry.name.startsWith('.dev.vars') && entry.name !== '.dev.vars.example')
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
const sourceFiles = await files(root);
const manifest = await Promise.all(
  sourceFiles.map(async (path) => ({
    file: relative(root, path).replaceAll('\\', '/'),
    bytes: (await readFile(path)).length,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  })),
);
const fileName = join(outputDirectory, 'club-work-checkin.zip');
const destination = createWriteStream(fileName);
const archive = archiver('zip', { zlib: { level: 9 } });
const completed = new Promise((resolve, reject) => {
  destination.on('close', resolve);
  destination.on('error', reject);
  archive.on('error', reject);
});
archive.pipe(destination);
for (const path of sourceFiles)
  archive.file(path, { name: `club-work-checkin/${relative(root, path).replaceAll('\\', '/')}` });
const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
archive.append(manifestJson, {
  name: `club-work-checkin/${manifestName}`,
});
await archive.finalize();
await completed;
await writeFile(join(outputDirectory, manifestName), manifestJson);
await writeFile(join(root, manifestName), manifestJson);
const digest = createHash('sha256')
  .update(await readFile(fileName))
  .digest('hex');
await writeFile(join(outputDirectory, 'SHA256.txt'), `${digest}  club-work-checkin.zip\n`);
console.log(
  `项目 ZIP：${fileName}\n文件数量：${sourceFiles.length}（另含文件清单）\nSHA-256：${digest}`,
);
