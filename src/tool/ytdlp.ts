// 本机侧：定位并执行 yt-dlp、读取 ffmpeg 路径、安装 / 更新 / 手动指定 yt-dlp。
// yt-dlp 放在应用数据目录的 yt-dlp 子文件夹，shell 权限范围（capabilities）只允许执行这两个固定路径。
import { Command } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join, downloadDir } from '@tauri-apps/api/path';
import { copyFile, exists, stat, writeFile } from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { ensureDir } from '../kit/platform';
import { detectPlatform, ytdlpAsset, LATEST_API, isNewerVersion } from './core';
import { installYtdlp, type InstallDeps, type RunResult, type YtdlpDeps } from './flow';

export const platform = () => detectPlatform(navigator.userAgent);

function assetInfo() {
  const a = ytdlpAsset(platform());
  if (!a) throw new Error('当前系统暂不支持（仅支持 Windows 和 macOS）');
  return a;
}

export async function ytdlpPath(): Promise<string> {
  return join(await appDataDir(), 'yt-dlp', assetInfo().asset);
}

export async function isInstalled(): Promise<boolean> {
  return exists(await ytdlpPath());
}

async function place(bytesOrCopy: { bytes: Uint8Array } | { from: string }): Promise<void> {
  const target = await ytdlpPath();
  await ensureDir(await join(await appDataDir(), 'yt-dlp'));
  if ('bytes' in bytesOrCopy) await writeFile(target, bytesOrCopy.bytes);
  else await copyFile(bytesOrCopy.from, target);
  await invoke('make_executable', { path: target });
}

/** 手动指定本机已有的 yt-dlp：复制到应用数据目录，再用它执行 */
export async function useLocalYtdlp(from: string): Promise<void> {
  await place({ from });
}

export async function runYtdlp(args: string[], onLine: (line: string, stream: 'out' | 'err') => void, signal?: AbortSignal): Promise<RunResult> {
  // 传了 env 时沿用当前进程的环境变量（Windows 下运行 PyInstaller 程序需要系统变量），只追加编码设置
  const cmd = Command.create(assetInfo().scope, args, { env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  const stdout: string[] = [];
  const stderr: string[] = [];
  cmd.stdout.on('data', (l: string) => {
    stdout.push(l);
    onLine(l, 'out');
  });
  cmd.stderr.on('data', (l: string) => {
    stderr.push(l);
    if (stderr.length > 40) stderr.shift();
    onLine(l, 'err');
  });
  const child = await cmd.spawn();
  const onAbort = () => void child.kill();
  signal?.addEventListener('abort', onAbort, { once: true });
  const code = await new Promise<number | null>((resolve) => {
    cmd.on('close', (e) => resolve(e.code));
    cmd.on('error', () => resolve(null));
  });
  signal?.removeEventListener('abort', onAbort);
  return { code, stdout, stderr };
}

export async function ytdlpVersion(): Promise<string> {
  const r = await runYtdlp(['--ignore-config', '--version'], () => {});
  if (r.code !== 0) throw new Error(r.stderr.join(' ').trim() || 'yt-dlp 无法运行');
  return r.stdout.join('').trim();
}

export async function makeDeps(): Promise<YtdlpDeps> {
  const ffmpegPath = await invoke<string>('ffmpeg_path').catch(() => '');
  return {
    run: runYtdlp,
    ffmpegPath,
    fileSize: async (p) => {
      try {
        return (await stat(p)).size;
      } catch {
        return -1;
      }
    },
  };
}

const installDeps: InstallDeps = {
  async fetchText(url) {
    const r = await tauriFetch(url);
    if (!r.ok) throw new Error(`下载校验文件失败：HTTP ${r.status}`);
    return r.text();
  },
  async fetchBytes(url, progress) {
    const r = await tauriFetch(url);
    if (!r.ok || !r.body) throw new Error(`下载 yt-dlp 失败：HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0;
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total) progress(Math.min(1, got / total));
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  },
  install: (bytes) => place({ bytes }),
};

export const downloadYtdlp = (progress: (r: number) => void) => installYtdlp(installDeps, assetInfo().asset, progress);

/** 查询官方最新版本号（GitHub API，匿名每小时有次数限制） */
export async function latestVersion(): Promise<string> {
  const r = await tauriFetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`查询最新版本失败：HTTP ${r.status}`);
  const j = (await r.json()) as { tag_name?: string };
  if (!j.tag_name) throw new Error('查询最新版本失败：返回内容里没有版本号');
  return j.tag_name;
}

export async function defaultSaveDir(): Promise<string> {
  return join(await downloadDir(), '全网视频下载器');
}

export { isNewerVersion };
