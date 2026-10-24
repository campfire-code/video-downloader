// 截图和预览用的示例数据：链接用 example.com 占位，标题标明「示例」，不含真实视频信息。
import { qualityOptions, parseInfo, initialState, type DownloadState, type VideoInfo } from './core';

export const SAMPLE_INFO_JSON = JSON.stringify({
  id: 'demo001',
  title: '示例视频 A（占位，非真实视频）',
  duration: 312,
  uploader: '示例频道',
  extractor_key: 'Generic',
  formats: [
    { format_id: 'a1', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 4_800_000 },
    { format_id: 'v360', vcodec: 'avc1', acodec: 'none', height: 360, filesize: 14_000_000 },
    { format_id: 'v720', vcodec: 'avc1', acodec: 'none', height: 720, filesize: 52_000_000 },
    { format_id: 'v1080', vcodec: 'avc1', acodec: 'none', height: 1080, filesize: 96_000_000 },
  ],
});

const info = (title: string, duration: number): VideoInfo => {
  const r = parseInfo(SAMPLE_INFO_JSON);
  if (!r.ok) throw new Error(r.error);
  return { ...r.info, title, duration };
};

export type ItemStatus = 'parsing' | 'ready' | 'downloading' | 'done' | 'error';

export interface Item {
  id: string;
  url: string;
  status: ItemStatus;
  info?: VideoInfo;
  quality: string;
  state?: DownloadState;
  error?: string;
  outPath?: string;
  size?: number;
}

const dl: DownloadState = { ...initialState(), stage: 'downloading', segments: 1, percent: 63.4, total: '92.4MiB', speed: '3.21MiB/s', eta: '00:11' };

export const SAMPLE_ITEMS: Item[] = [
  { id: 's1', url: 'https://example.com/video/demo-001', status: 'done', info: info('示例视频 A（占位，非真实视频）', 312), quality: 'h720', outPath: '/Users/demo/Downloads/全网视频下载器/示例视频 A [demo001].mp4', size: 52_428_800 },
  { id: 's2', url: 'https://example.com/video/demo-002', status: 'downloading', info: info('示例视频 B（占位，非真实视频）', 1285), quality: 'h1080', state: dl },
  { id: 's3', url: 'https://example.com/video/demo-003', status: 'ready', info: info('示例视频 C（占位，非真实视频）', 96), quality: 'best' },
  { id: 's4', url: 'https://example.com/members/demo-004', status: 'error', quality: 'best', error: '这个内容需要登录或特殊权限，本工具不处理登录，无法下载（yt-dlp：[generic] This video is only available for registered users）' },
];

export const SAMPLE_OPTIONS = (it: Item) => (it.info ? qualityOptions(it.info) : []);
