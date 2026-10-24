// 纯函数：链接整理、yt-dlp 输出解析、命令参数生成、下载校验。不依赖界面和本机能力，便于单元测试。

export const MAX_LINKS = 20;

// ---------------- 链接 ----------------

export interface ParsedLinks {
  urls: string[];
  /** 不是 http(s) 链接的内容 */
  invalid: string[];
  /** 超出上限被忽略的数量 */
  skipped: number;
}

/** 从粘贴的文字里取出 http(s) 链接：按空白和逗号拆开，去重，最多 MAX_LINKS 个 */
export function parseLinks(text: string, max = MAX_LINKS): ParsedLinks {
  const seen = new Set<string>();
  const urls: string[] = [];
  const invalid: string[] = [];
  let skipped = 0;
  for (const raw of text.split(/[\s,，;；]+/)) {
    const t = raw.trim();
    if (!t) continue;
    let ok = false;
    try {
      const u = new URL(t);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
    } catch {
      ok = false;
    }
    if (!ok) {
      invalid.push(t);
      continue;
    }
    if (seen.has(t)) continue;
    seen.add(t);
    if (urls.length >= max) skipped++;
    else urls.push(t);
  }
  return { urls, invalid, skipped };
}

// ---------------- 视频信息（yt-dlp -J） ----------------

export interface RawFormat {
  format_id?: string;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
}

export interface VideoInfo {
  id: string;
  title: string;
  duration: number;
  uploader: string;
  site: string;
  /** 视频流可选的高度，从高到低 */
  heights: number[];
  hasAudio: boolean;
  formats: RawFormat[];
}

export type InfoResult = { ok: true; info: VideoInfo } | { ok: false; error: string };

const hasVideo = (f: RawFormat) => !!f.vcodec && f.vcodec !== 'none';
const hasAudioCodec = (f: RawFormat) => !!f.acodec && f.acodec !== 'none';
const sizeOf = (f: RawFormat) => f.filesize ?? f.filesize_approx ?? 0;

/** 解析 yt-dlp -J 的输出。播放列表不支持，请用户粘贴单个视频链接 */
export function parseInfo(json: string): InfoResult {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { ok: false, error: '没有读到视频信息（yt-dlp 的输出不是有效的 JSON）' };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: '没有读到视频信息' };
  if (raw._type === 'playlist') return { ok: false, error: '这是播放列表或合集链接，暂不支持，请粘贴单个视频的链接' };
  const formats = Array.isArray(raw.formats) ? (raw.formats as RawFormat[]) : [];
  const heights = [...new Set(formats.filter((f) => hasVideo(f) && typeof f.height === 'number' && f.height > 0).map((f) => f.height as number))].sort((a, b) => b - a);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    ok: true,
    info: {
      id: str(raw.id),
      title: str(raw.title) || str(raw.id) || '未命名视频',
      duration: typeof raw.duration === 'number' ? raw.duration : 0,
      uploader: str(raw.uploader) || str(raw.channel),
      site: str(raw.extractor_key) || str(raw.extractor),
      heights,
      hasAudio: formats.some((f) => hasAudioCodec(f)),
      formats,
    },
  };
}

// ---------------- 清晰度 ----------------

export interface QualityOption {
  id: string;
  label: string;
  /** yt-dlp -f 的格式选择表达式 */
  selector: string;
  audioOnly: boolean;
  /** 估计大小（字节），无法估计为 0 */
  size: number;
}

/** 某个高度以内最大的视频流 + 最大的音频流，估计合并后的大小 */
function estimateSize(formats: RawFormat[], maxHeight: number | null): number {
  const vids = formats.filter((f) => hasVideo(f) && (maxHeight === null || (f.height ?? 0) <= maxHeight));
  const auds = formats.filter((f) => hasAudioCodec(f) && !hasVideo(f));
  const v = Math.max(0, ...vids.map(sizeOf));
  const a = Math.max(0, ...auds.map(sizeOf));
  return v + a;
}

export function qualityOptions(info: VideoInfo): QualityOption[] {
  const opts: QualityOption[] = [{ id: 'best', label: '最佳画质', selector: 'bv*+ba/b', audioOnly: false, size: estimateSize(info.formats, null) }];
  for (const h of info.heights) {
    opts.push({ id: `h${h}`, label: `${h}p`, selector: `bv*[height<=${h}]+ba/b[height<=${h}]`, audioOnly: false, size: estimateSize(info.formats, h) });
  }
  if (info.hasAudio || info.heights.length === 0) {
    const a = Math.max(0, ...info.formats.filter((f) => hasAudioCodec(f) && !hasVideo(f)).map(sizeOf));
    opts.push({ id: 'audio', label: '仅音频（MP3）', selector: 'ba/b', audioOnly: true, size: a });
  }
  return opts;
}

export function formatBytes(n: number): string {
  if (!n || n <= 0) return '未知大小';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

// ---------------- 命令参数 ----------------

/** 两条命令共用的参数：忽略用户机器上的 yt-dlp 配置文件；不读 cookie，不碰浏览器 */
const BASE_ARGS = ['--ignore-config', '--no-colors', '--no-playlist'];

export function buildInfoArgs(url: string): string[] {
  return [...BASE_ARGS, '--no-warnings', '-J', '--', url];
}

export interface DownloadSpec {
  url: string;
  outDir: string;
  ffmpegPath: string;
  quality: Pick<QualityOption, 'selector' | 'audioOnly'>;
}

export function buildDownloadArgs(s: DownloadSpec): string[] {
  const args = [...BASE_ARGS, '--newline', '--windows-filenames', '--retries', '3', '-P', s.outDir, '-o', '%(title).120B [%(id)s].%(ext)s', '-f', s.quality.selector];
  if (s.ffmpegPath) args.push('--ffmpeg-location', s.ffmpegPath);
  if (s.quality.audioOnly) args.push('-x', '--audio-format', 'mp3');
  else args.push('--merge-output-format', 'mp4');
  args.push('--', s.url);
  return args;
}

// ---------------- 进度输出（--newline） ----------------

export type YtLine =
  | { kind: 'progress'; percent: number; total: string; speed: string; eta: string }
  | { kind: 'dest'; path: string }
  | { kind: 'merge'; path: string }
  | { kind: 'extract'; path: string }
  | { kind: 'exists'; path: string }
  | { kind: 'finished'; total: string }
  | { kind: 'other' };

const PROGRESS = /^\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*(\S+)(?:\s+at\s+(.+?))?(?:\s+ETA\s+(\S+))?(?:\s+\(frag.*\))?\s*$/;
const FINISHED = /^\[download\]\s+100(?:\.0)?%\s+of\s+~?\s*(\S+)\s+in\s+/;

export function parseProgressLine(line: string): YtLine {
  const t = line.trim();
  let m: RegExpExecArray | null;
  if ((m = FINISHED.exec(t))) return { kind: 'finished', total: m[1] };
  if ((m = PROGRESS.exec(t))) {
    const unknown = (v?: string) => (!v || /^Unknown/i.test(v) ? '' : v);
    return { kind: 'progress', percent: Math.min(100, Number(m[1])), total: m[2], speed: unknown(m[3]), eta: unknown(m[4]) };
  }
  if ((m = /^\[download\] Destination: (.+)$/.exec(t))) return { kind: 'dest', path: m[1] };
  if ((m = /^\[Merger\] Merging formats into "(.+)"$/.exec(t))) return { kind: 'merge', path: m[1] };
  if ((m = /^\[ExtractAudio\] Destination: (.+)$/.exec(t))) return { kind: 'extract', path: m[1] };
  if ((m = /^\[download\] (.+) has already been downloaded$/.exec(t))) return { kind: 'exists', path: m[1] };
  return { kind: 'other' };
}

/** 汇总一次下载的状态：当前阶段、百分比、最终文件路径 */
export interface DownloadState {
  stage: 'start' | 'downloading' | 'merging' | 'done';
  /** 已出现的下载段数（视频流、音频流各算一段） */
  segments: number;
  percent: number;
  speed: string;
  eta: string;
  total: string;
  /** 最终输出文件：合并 > 提取音频 > 最后一个下载目标 */
  finalPath: string;
}

export const initialState = (): DownloadState => ({ stage: 'start', segments: 0, percent: 0, speed: '', eta: '', total: '', finalPath: '' });

export function applyLine(s: DownloadState, line: string): DownloadState {
  const e = parseProgressLine(line);
  switch (e.kind) {
    case 'dest':
      return { ...s, stage: 'downloading', segments: s.segments + 1, percent: 0, finalPath: e.path };
    case 'progress':
      return { ...s, stage: 'downloading', percent: e.percent, speed: e.speed, eta: e.eta, total: e.total };
    case 'finished':
      return { ...s, percent: 100, total: e.total, speed: '', eta: '' };
    case 'merge':
      return { ...s, stage: 'merging', finalPath: e.path };
    case 'extract':
      return { ...s, stage: 'merging', finalPath: e.path };
    case 'exists':
      return { ...s, stage: 'done', percent: 100, finalPath: e.path };
    default:
      return s;
  }
}

// ---------------- 错误原因 ----------------

const HINTS: [RegExp, string][] = [
  [/sign in|log ?in|login|private video|members[- ]only|cookies|authentication|premium|age[- ]restricted|confirm your age/i, '这个内容需要登录或特殊权限，本工具不处理登录，无法下载'],
  [/unsupported url/i, 'yt-dlp 不支持这个链接，请确认是视频页面的地址'],
  [/HTTP Error 404|not found|does not exist|has been removed|unavailable/i, '视频不存在、已被删除或暂时不可用'],
  [/HTTP Error 403|forbidden/i, '网站拒绝了访问（403），可能有地区或访问限制'],
  [/HTTP Error 429|too many requests/i, '请求太频繁被网站限制，请过一会儿再试'],
  [/geo|not available in your country|your location/i, '该内容有地区限制'],
  [/timed out|timeout|temporary failure|name or service not known|nodename nor servname|network is unreachable|connection (refused|reset)|getaddrinfo|urlopen error/i, '网络连接失败，请检查网络后重试'],
  [/ffmpeg|ffprobe/i, '合并音视频需要 ffmpeg，请重启应用后再试'],
  [/no space left|disk full/i, '磁盘空间不足'],
  [/permission denied/i, '没有写入权限，请换一个保存文件夹'],
];

/** 从 yt-dlp 的错误输出里取出原因，附中文说明。原文始终保留 */
export function explainError(lines: string[], code: number | null): string {
  const errs = lines.map((l) => l.trim()).filter((l) => /^ERROR:/i.test(l));
  const reason = (errs[errs.length - 1] ?? lines.map((l) => l.trim()).filter(Boolean).pop() ?? '').replace(/^ERROR:\s*/i, '');
  if (!reason) return `yt-dlp 退出码 ${code ?? '未知'}，没有输出错误原因`;
  const hint = HINTS.find(([re]) => re.test(reason))?.[1];
  return hint ? `${hint}（yt-dlp：${reason}）` : `yt-dlp：${reason}`;
}

// ---------------- 下载校验 ----------------

export interface DownloadResult {
  code: number | null;
  finalPath: string;
  /** 文件实际大小，找不到文件为 -1 */
  size: number;
}

/** 返回错误说明，通过返回 null */
export function verifyDownload(r: DownloadResult): string | null {
  if (r.code !== 0) return r.code === null ? '下载被中断' : `yt-dlp 异常退出（退出码 ${r.code}）`;
  if (!r.finalPath) return '没有识别到输出文件，请到保存文件夹里确认';
  if (/\.(part|ytdl)$/i.test(r.finalPath)) return '下载没有完成（只有临时文件）';
  if (r.size < 0) return `输出文件不存在：${r.finalPath}`;
  if (r.size === 0) return '输出文件是空的';
  return null;
}

// ---------------- yt-dlp 程序：平台、校验和、版本 ----------------

export type Platform = 'mac' | 'win' | 'other';

export function detectPlatform(userAgent: string): Platform {
  if (/Windows/i.test(userAgent)) return 'win';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'mac';
  return 'other';
}

/** 官方 release 的资产名（核实自 yt-dlp 2026.10.21 的 release 资产列表）和本地文件名、shell 范围名 */
export function ytdlpAsset(p: Platform): { asset: string; scope: string } | null {
  if (p === 'mac') return { asset: 'yt-dlp_macos', scope: 'yt-dlp-mac' };
  if (p === 'win') return { asset: 'yt-dlp.exe', scope: 'yt-dlp-win' };
  return null;
}

export const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
export const LATEST_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

/** 解析 SHA2-256SUMS：每行「64 位十六进制  文件名」 */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line);
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 校验下载到的程序；通过返回 null */
export async function verifyBinary(bytes: Uint8Array, sumsText: string, asset: string): Promise<string | null> {
  const expect = parseSums(sumsText)[asset];
  if (!expect) return `官方校验文件里没有找到 ${asset} 的校验值`;
  if (bytes.length === 0) return '下载到的文件是空的';
  const got = await sha256Hex(bytes);
  return got === expect ? null : '校验失败：下载内容与官方 SHA2-256SUMS 不一致，已丢弃，请重试';
}

/** yt-dlp 版本号形如 2026.10.21 或 2026.10.21.123456（夜间版）。a 比 b 新返回 true */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.trim().split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.trim().split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
