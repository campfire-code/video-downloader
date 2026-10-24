// 流程：解析链接、下载、安装 / 更新 yt-dlp。本机能力（执行程序、网络、文件）通过 Deps 注入，测试里用假的。
import { applyLine, buildDownloadArgs, buildInfoArgs, explainError, initialState, parseInfo, verifyBinary, verifyDownload, RELEASE_BASE, type DownloadState, type QualityOption, type VideoInfo } from './core';

export interface RunResult {
  code: number | null;
  /** 标准输出全部行 */
  stdout: string[];
  /** 标准错误最后若干行 */
  stderr: string[];
}

export interface YtdlpDeps {
  /** 执行 yt-dlp，逐行回调输出；signal 中止时结束进程 */
  run(args: string[], onLine: (line: string, stream: 'out' | 'err') => void, signal?: AbortSignal): Promise<RunResult>;
  /** 文件大小，不存在返回 -1 */
  fileSize(path: string): Promise<number>;
  ffmpegPath: string;
}

export async function fetchInfo(deps: YtdlpDeps, url: string, signal?: AbortSignal): Promise<VideoInfo> {
  const r = await deps.run(buildInfoArgs(url), () => {}, signal);
  if (signal?.aborted) throw new Error('已取消');
  if (r.code !== 0) throw new Error(explainError(r.stderr, r.code));
  const parsed = parseInfo(r.stdout.join('\n'));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.info;
}

export interface DownloadOutcome {
  path: string;
  size: number;
}

export async function downloadVideo(
  deps: YtdlpDeps,
  spec: { url: string; outDir: string; quality: QualityOption },
  onState: (s: DownloadState) => void,
  signal?: AbortSignal,
): Promise<DownloadOutcome> {
  let state = initialState();
  const args = buildDownloadArgs({ url: spec.url, outDir: spec.outDir, ffmpegPath: deps.ffmpegPath, quality: spec.quality });
  const r = await deps.run(args, (line) => {
    state = applyLine(state, line);
    onState(state);
  }, signal);
  if (signal?.aborted) throw new Error('已取消');
  if (r.code !== 0) throw new Error(explainError(r.stderr, r.code));
  // yt-dlp 打印的是相对 -P 的路径时，补全成绝对路径
  const path = /^([/\\]|[A-Za-z]:)/.test(state.finalPath) ? state.finalPath : state.finalPath ? `${spec.outDir.replace(/[/\\]$/, '')}/${state.finalPath}` : '';
  const size = path ? await deps.fileSize(path) : -1;
  const bad = verifyDownload({ code: r.code, finalPath: path, size });
  if (bad) throw new Error(bad);
  onState({ ...state, stage: 'done', percent: 100 });
  return { path, size };
}

// ---------------- 安装 / 更新 yt-dlp ----------------

export interface InstallDeps {
  fetchText(url: string): Promise<string>;
  /** 下载二进制，progress 收到 0~1 */
  fetchBytes(url: string, progress: (ratio: number) => void): Promise<Uint8Array>;
  /** 写入应用数据目录里的最终位置，并在需要时设为可执行 */
  install(bytes: Uint8Array): Promise<void>;
}

/** 下载官方 release 的独立可执行文件，用同一 release 的 SHA2-256SUMS 校验通过后才写入 */
export async function installYtdlp(deps: InstallDeps, asset: string, progress: (ratio: number) => void): Promise<void> {
  const sums = await deps.fetchText(`${RELEASE_BASE}/SHA2-256SUMS`);
  const bytes = await deps.fetchBytes(`${RELEASE_BASE}/${asset}`, progress);
  const bad = await verifyBinary(bytes, sums, asset);
  if (bad) throw new Error(bad);
  await deps.install(bytes);
}
