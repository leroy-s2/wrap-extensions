#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import protobuf from 'protobufjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APK_DIR = path.join(ROOT, 'apk');
const ICON_DIR = path.join(ROOT, 'icon');
const INDEX_FILE = path.join(ROOT, 'index.min.json');
const REPO_FILE = path.join(ROOT, 'repo.json');
const PROTO_FILE = path.join(ROOT, 'index.proto');

const PB_URLS = [
  'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb',
  'https://github.com/keiyoushi/extensions/raw/repo/index.pb',
];
const ASSETS_URLS = [
  'https://raw.githubusercontent.com/keiyoushi/extensions/repo/release-assets.json',
  'https://github.com/keiyoushi/extensions/raw/repo/release-assets.json',
];
const ICON_FALLBACK = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/icon';
const USER_AGENT = 'wrap-extensions/1.0';
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.CONCURRENCY) || 8));
const SKIP_ASSETS = process.env.SKIP_ASSETS === '1';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchBuffer(url, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

async function fetchFirst(urls, label) {
  const errors = [];
  for (const url of urls) {
    try {
      return await fetchBuffer(url);
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`Could not fetch ${label}:\n${errors.join('\n')}`);
}

async function writeAtomic(file, data) {
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateFileType(buffer, destination) {
  if (destination.endsWith('.apk')) {
    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
    if (!isZip) throw new Error(`Downloaded file is not an APK: ${destination}`);
  }
  if (destination.endsWith('.png')) {
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    if (!isPng) throw new Error(`Downloaded file is not a PNG: ${destination}`);
  }
}

async function downloadFile(url, destination, expectedSha256, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const buffer = await fetchBuffer(url);
      validateFileType(buffer, destination);
      if (expectedSha256) {
        const actualSha256 = createHash('sha256').update(buffer).digest('hex');
        if (actualSha256 !== expectedSha256) {
          throw new Error(
            `sha256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`,
          );
        }
      }
      await writeAtomic(destination, buffer);
      return buffer.length;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function listFiles(directory, filter) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && filter(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function apkFileName(apkUrl, pkg) {
  let raw;
  try {
    raw = new URL(apkUrl).pathname.split('/').pop() ?? '';
  } catch {
    throw new Error(`Invalid APK URL for ${pkg}: ${apkUrl}`);
  }
  const name = decodeURIComponent(raw);
  if (!name || name.includes('/') || name.includes('\\') || !name.endsWith('.apk')) {
    throw new Error(`Invalid APK filename for ${pkg}: ${name}`);
  }
  return name;
}

function extensionLanguage(pkg, sources) {
  const folder = pkg.split('.')[4] ?? 'all';
  if (folder === 'all') return 'all';
  const languages = [...new Set(sources.map((source) => source.language).filter(Boolean))];
  return languages.length === 1 ? languages[0] : folder;
}

function toLegacyExtension(extension) {
  const pkg = extension.packageName ?? '';
  if (!pkg) throw new Error('Extension without package name');
  const apkUrl = extension.resources?.apkUrl ?? '';
  if (!apkUrl) throw new Error(`Extension without APK URL: ${pkg}`);
  const sources = extension.sources ?? [];
  return {
    name: extension.name ?? '',
    pkg,
    apk: apkFileName(apkUrl, pkg),
    lang: extensionLanguage(pkg, sources),
    code: Number(extension.versionCode ?? 0),
    version: extension.versionName ?? '',
    nsfw: extension.contentWarning === 'CONTENT_WARNING_NSFW' ? 1 : 0,
    sources: sources.map((source) => {
      if (source.id === undefined || source.id === null) {
        throw new Error(`Source without id in ${pkg}`);
      }
      return {
        name: source.name ?? '',
        lang: source.language ?? '',
        id: String(source.id),
        baseUrl: source.homeUrl ?? '',
      };
    }),
  };
}

function toRepoMetadata(index) {
  if (!index.signingKey) throw new Error('index.pb has no signing key');
  const meta = {
    name: index.name ?? 'Keiyoushi',
    website: index.contact?.website || 'https://keiyoushi.github.io',
    signingKeyFingerprint: index.signingKey,
  };
  if (index.badgeLabel) meta.shortName = index.badgeLabel;
  return { meta };
}

async function fetchReleaseAssets() {
  try {
    const buffer = await fetchFirst(ASSETS_URLS, 'release-assets.json');
    const assets = JSON.parse(buffer.toString('utf8'));
    console.log(`Loaded release-assets.json for ${Object.keys(assets).length} packages`);
    return assets;
  } catch (error) {
    console.warn(
      `WARNING: release-assets.json unavailable, APK hashes will not be verified: ${error.message}`,
    );
    return {};
  }
}

async function syncApks(extensions, releaseAssets) {
  await mkdir(APK_DIR, { recursive: true });
  for (const name of await listFiles(APK_DIR, (file) => file.includes('.tmp-'))) {
    await rm(path.join(APK_DIR, name), { force: true });
  }

  const expected = new Map();
  for (const extension of extensions) {
    const pkg = extension.packageName;
    const apkUrl = extension.resources?.apkUrl;
    const name = apkFileName(apkUrl, pkg);
    if (expected.has(name)) throw new Error(`Duplicate APK filename: ${name}`);
    const asset = Object.hasOwn(releaseAssets, pkg) ? releaseAssets[pkg]?.apk : undefined;
    expected.set(name, {
      url: apkUrl,
      sha256: asset?.name === name ? asset.sha256 : undefined,
    });
  }

  const existing = new Set(await listFiles(APK_DIR, (file) => file.endsWith('.apk')));
  const toDownload = [];
  let kept = 0;

  const current = [...existing].filter((name) => expected.has(name));
  await mapLimit(current, CONCURRENCY, async (name) => {
    const info = expected.get(name);
    if (!info.sha256) {
      kept++;
      return;
    }
    const actual = await sha256File(path.join(APK_DIR, name));
    if (actual === info.sha256) {
      kept++;
    } else {
      toDownload.push([name, info]);
    }
  });

  for (const [name, info] of expected) {
    if (!existing.has(name)) toDownload.push([name, info]);
  }
  toDownload.sort(([first], [second]) => first.localeCompare(second));

  console.log(`APKs: ${kept} up to date, ${toDownload.length} to download`);
  let downloaded = 0;
  await mapLimit(toDownload, CONCURRENCY, async ([name, info]) => {
    await downloadFile(info.url, path.join(APK_DIR, name), info.sha256);
    downloaded++;
    if (downloaded % 100 === 0 || downloaded === toDownload.length) {
      console.log(`  downloaded ${downloaded}/${toDownload.length}`);
    }
  });

  let deleted = 0;
  for (const name of existing) {
    if (!expected.has(name)) {
      await rm(path.join(APK_DIR, name), { force: true });
      deleted++;
    }
  }
  console.log(`APKs: ${kept} kept, ${downloaded} downloaded, ${deleted} deleted`);
}

async function syncIcons(extensions) {
  await mkdir(ICON_DIR, { recursive: true });
  const expected = new Map();
  for (const extension of extensions) {
    const pkg = extension.packageName ?? '';
    if (!/^[a-z0-9_.]+$/i.test(pkg)) throw new Error(`Invalid package name: ${pkg}`);
    expected.set(pkg, extension.resources?.iconUrl || `${ICON_FALLBACK}/${pkg}.png`);
  }

  const existing = new Set(await listFiles(ICON_DIR, (file) => file.endsWith('.png')));
  const missing = [];
  let kept = 0;
  for (const pkg of expected.keys()) {
    if (existing.has(`${pkg}.png`)) kept++;
    else missing.push(pkg);
  }

  console.log(`Icons: ${kept} present, ${missing.length} to download`);
  let downloaded = 0;
  let failed = 0;
  await mapLimit(missing, CONCURRENCY, async (pkg) => {
    try {
      await downloadFile(expected.get(pkg), path.join(ICON_DIR, `${pkg}.png`));
      downloaded++;
    } catch (error) {
      failed++;
      console.warn(`WARNING: icon download failed for ${pkg}: ${error.message}`);
    }
  });

  let deleted = 0;
  for (const name of existing) {
    if (!expected.has(name.slice(0, -4))) {
      await rm(path.join(ICON_DIR, name), { force: true });
      deleted++;
    }
  }
  console.log(`Icons: ${kept} kept, ${downloaded} downloaded, ${failed} failed, ${deleted} deleted`);
}

async function main() {
  console.log('Fetching keiyoushi index.pb...');
  const compressed = await fetchFirst(PB_URLS, 'index.pb');
  const raw =
    compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync(compressed) : compressed;
  console.log(`index.pb: ${compressed.length} bytes compressed, ${raw.length} bytes decoded`);

  const root = await protobuf.load(PROTO_FILE);
  const ExtensionIndex = root.lookupType('ExtensionIndex');
  const decoded = ExtensionIndex.decode(raw);
  const index = ExtensionIndex.toObject(decoded, {
    longs: String,
    enums: String,
    defaults: true,
    arrays: true,
  });

  const extensions = index.extensionList?.extensions ?? [];
  if (extensions.length === 0) throw new Error('index.pb contains no extensions');
  console.log(`Decoded ${extensions.length} extensions`);

  const legacy = extensions.map(toLegacyExtension);
  const repo = toRepoMetadata(index);

  if (SKIP_ASSETS) {
    console.log('SKIP_ASSETS=1: skipping APK and icon mirroring');
  } else {
    const releaseAssets = await fetchReleaseAssets();
    await syncApks(extensions, releaseAssets);
    await syncIcons(extensions);
  }

  await writeAtomic(INDEX_FILE, `${JSON.stringify(legacy)}\n`);
  await writeAtomic(REPO_FILE, `${JSON.stringify(repo, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, INDEX_FILE)} (${legacy.length} entries)`);
  console.log(`Wrote ${path.relative(ROOT, REPO_FILE)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
