import { describe, expect, it } from 'vitest';
import {
  applyLine, buildDownloadArgs, buildInfoArgs, detectPlatform, explainError, formatBytes, formatDuration, initialState, isNewerVersion, parseInfo, parseLinks,
  parseProgressLine, parseSums, qualityOptions, sha256Hex, verifyBinary, verifyDownload, ytdlpAsset,
} from './core';
import { SAMPLE_INFO_JSON } from './samples';

describe('链接整理', () => {
  it('拆开、去重、过滤非 http 链接', () => {
    const r = parseLinks('https://example.com/a\nhttps://example.com/a, ftp://x.com/b  not-a-link\nhttp://example.com/c');
    expect(r.urls).toEqual(['https://example.com/a', 'http://example.com/c']);
    expect(r.invalid).toEqual(['ftp://x.com/b', 'not-a-link']);
  });
  it('超出上限的记数', () => {
    const text = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`).join(' ');
    const r = parseLinks(text, 3);
    expect(r.urls).toHaveLength(3);
    expect(r.skipped).toBe(2);
  });
  it('空输入', () => {
    expect(parseLinks('  \n ')).toEqual({ urls: [], invalid: [], skipped: 0 });
  });
});

describe('视频信息与清晰度', () => {
  const r = parseInfo(SAMPLE_INFO_JSON);
  it('解析手写样例', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.title).toContain('示例视频');
    expect(r.info.heights).toEqual([1080, 720, 360]);
    expect(r.info.hasAudio).toBe(true);
    expect(r.info.duration).toBe(312);
  });
  it('生成清晰度选项并估算大小', () => {
    if (!r.ok) throw new Error('x');
    const opts = qualityOptions(r.info);
    expect(opts.map((o) => o.label)).toEqual(['最佳画质', '1080p', '720p', '360p', '仅音频（MP3）']);
    expect(opts[1].selector).toBe('bv*[height<=1080]+ba/b[height<=1080]');
    expect(opts[1].size).toBe(96_000_000 + 4_800_000);
    expect(opts[2].size).toBe(52_000_000 + 4_800_000);
    expect(opts[4].audioOnly).toBe(true);
    expect(opts[4].size).toBe(4_800_000);
  });
  it('没有分辨率信息的直链只有最佳和音频', () => {
    const d = parseInfo(JSON.stringify({ id: 'x', title: 't', formats: [{ format_id: 'mp4', vcodec: null }] }));
    if (!d.ok) throw new Error('x');
    expect(qualityOptions(d.info).map((o) => o.id)).toEqual(['best', 'audio']);
  });
  it('播放列表和坏 JSON 给出明确提示', () => {
    expect(parseInfo(JSON.stringify({ _type: 'playlist', entries: [] }))).toEqual({ ok: false, error: expect.stringContaining('播放列表') });
    expect(parseInfo('not json')).toEqual({ ok: false, error: expect.stringContaining('JSON') });
  });
});

describe('命令参数', () => {
  it('解析命令：只读信息，不带 cookie', () => {
    const a = buildInfoArgs('https://example.com/v');
    expect(a).toEqual(['--ignore-config', '--no-colors', '--no-playlist', '--no-warnings', '-J', '--', 'https://example.com/v']);
  });
  it('视频下载：合并 mp4，传入 ffmpeg 路径，链接前有 --', () => {
    const a = buildDownloadArgs({ url: 'https://example.com/v', outDir: '/tmp/out', ffmpegPath: '/app/ffmpeg', quality: { selector: 'bv*+ba/b', audioOnly: false } });
    expect(a).toContain('--newline');
    expect(a.slice(a.indexOf('-P'), a.indexOf('-P') + 2)).toEqual(['-P', '/tmp/out']);
    expect(a.slice(a.indexOf('--ffmpeg-location'), a.indexOf('--ffmpeg-location') + 2)).toEqual(['--ffmpeg-location', '/app/ffmpeg']);
    expect(a).toContain('--merge-output-format');
    expect(a).not.toContain('-x');
    expect(a.slice(-2)).toEqual(['--', 'https://example.com/v']);
  });
  it('仅音频：提取为 mp3', () => {
    const a = buildDownloadArgs({ url: 'https://example.com/v', outDir: '/o', ffmpegPath: '', quality: { selector: 'ba/b', audioOnly: true } });
    expect(a).toEqual(expect.arrayContaining(['-x', '--audio-format', 'mp3']));
    expect(a).not.toContain('--ffmpeg-location');
    expect(a).not.toContain('--merge-output-format');
  });
  it('任何命令都不读取 cookie 或浏览器', () => {
    const all = [...buildInfoArgs('https://example.com/v'), ...buildDownloadArgs({ url: 'https://example.com/v', outDir: '/o', ffmpegPath: '/f', quality: { selector: 'b', audioOnly: false } })];
    expect(all.some((x) => /cookie|browser|username|password/i.test(x))).toBe(false);
    expect(all).toContain('--ignore-config');
  });
});

describe('进度行解析（--newline 输出）', () => {
  it('普通进度行', () => {
    expect(parseProgressLine('[download]  45.2% of   10.00MiB at    1.20MiB/s ETA 00:05')).toEqual({ kind: 'progress', percent: 45.2, total: '10.00MiB', speed: '1.20MiB/s', eta: '00:05' });
  });
  it('估算总大小与分片', () => {
    expect(parseProgressLine('[download]   3.0% of ~  52.00MiB at  800.00KiB/s ETA 01:02 (frag 3/100)')).toEqual({ kind: 'progress', percent: 3, total: '52.00MiB', speed: '800.00KiB/s', eta: '01:02' });
  });
  it('速度未知（本机真实输出）', () => {
    expect(parseProgressLine('[download]   1.1% of   93.46KiB at  Unknown B/s ETA Unknown')).toEqual({ kind: 'progress', percent: 1.1, total: '93.46KiB', speed: '', eta: '' });
  });
  it('完成行', () => {
    expect(parseProgressLine('[download] 100% of   93.46KiB in 00:00:00 at 21.28MiB/s')).toEqual({ kind: 'finished', total: '93.46KiB' });
  });
  it('目标文件、合并、提取音频、已存在', () => {
    expect(parseProgressLine('[download] Destination: out/a [x].f137.mp4')).toEqual({ kind: 'dest', path: 'out/a [x].f137.mp4' });
    expect(parseProgressLine('[Merger] Merging formats into "out/a [x].mp4"')).toEqual({ kind: 'merge', path: 'out/a [x].mp4' });
    expect(parseProgressLine('[ExtractAudio] Destination: out/a [x].mp3')).toEqual({ kind: 'extract', path: 'out/a [x].mp3' });
    expect(parseProgressLine('[download] out/a [x].mp4 has already been downloaded')).toEqual({ kind: 'exists', path: 'out/a [x].mp4' });
  });
  it('其他行忽略', () => {
    expect(parseProgressLine('[generic] sample: Downloading webpage').kind).toBe('other');
    expect(parseProgressLine('').kind).toBe('other');
  });
  it('一次「视频 + 音频 + 合并」的完整输出得到最终文件', () => {
    const lines = [
      '[info] x: Downloading 1 format(s): 137+140',
      '[download] Destination: o/t [x].f137.mp4',
      '[download]  50.0% of   10.00MiB at    2.00MiB/s ETA 00:02',
      '[download] 100% of   10.00MiB in 00:00:05 at 2.00MiB/s',
      '[download] Destination: o/t [x].f140.m4a',
      '[download]  20.0% of    1.00MiB at    2.00MiB/s ETA 00:01',
      '[Merger] Merging formats into "o/t [x].mp4"',
    ];
    let s = initialState();
    const seen: number[] = [];
    for (const l of lines) {
      s = applyLine(s, l);
      seen.push(s.segments);
    }
    expect(s.stage).toBe('merging');
    expect(s.segments).toBe(2);
    expect(s.finalPath).toBe('o/t [x].mp4');
    expect(seen[2]).toBe(1);
  });
});

describe('错误原因', () => {
  it('需要登录给出不支持说明并保留原文', () => {
    const m = explainError(['[youtube] abc: Downloading', "ERROR: [youtube] abc: Sign in to confirm you're not a bot"], 1);
    expect(m).toContain('不处理登录');
    expect(m).toContain("Sign in to confirm");
  });
  it('404 和网络错误', () => {
    expect(explainError(['ERROR: [generic] n: Unable to download webpage: HTTP Error 404: File not found'], 1)).toContain('不存在');
    expect(explainError(['ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>'], 1)).toContain('网络');
  });
  it('未知错误只带原文；没有输出时给退出码', () => {
    expect(explainError(['ERROR: something odd'], 1)).toBe('yt-dlp：something odd');
    expect(explainError([], 2)).toContain('退出码 2');
  });
});

describe('下载校验', () => {
  it('通过', () => expect(verifyDownload({ code: 0, finalPath: '/o/a.mp4', size: 1024 })).toBeNull());
  it('退出码非 0 / 被中断', () => {
    expect(verifyDownload({ code: 1, finalPath: '/o/a.mp4', size: 1024 })).toContain('退出码 1');
    expect(verifyDownload({ code: null, finalPath: '', size: -1 })).toContain('中断');
  });
  it('没有路径、临时文件、文件不存在、空文件', () => {
    expect(verifyDownload({ code: 0, finalPath: '', size: 0 })).toContain('没有识别');
    expect(verifyDownload({ code: 0, finalPath: '/o/a.mp4.part', size: 10 })).toContain('临时文件');
    expect(verifyDownload({ code: 0, finalPath: '/o/a.mp4', size: -1 })).toContain('不存在');
    expect(verifyDownload({ code: 0, finalPath: '/o/a.mp4', size: 0 })).toContain('空');
  });
});

describe('yt-dlp 程序：资产名、校验和、版本', () => {
  const bytes = new TextEncoder().encode('hello');
  const HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  it('平台与官方 release 资产名', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win');
    expect(detectPlatform('X11; Linux')).toBe('other');
    expect(ytdlpAsset('mac')?.asset).toBe('yt-dlp_macos');
    expect(ytdlpAsset('win')?.asset).toBe('yt-dlp.exe');
    expect(ytdlpAsset('other')).toBeNull();
  });
  it('解析 SHA2-256SUMS', () => {
    const t = `${HELLO}  yt-dlp_macos\n${'a'.repeat(64)} *yt-dlp.exe\n坏行\n`;
    expect(parseSums(t)).toEqual({ 'yt-dlp_macos': HELLO, 'yt-dlp.exe': 'a'.repeat(64) });
  });
  it('sha256 与校验', async () => {
    expect(await sha256Hex(bytes)).toBe(HELLO);
    const sums = `${HELLO}  yt-dlp_macos\n`;
    expect(await verifyBinary(bytes, sums, 'yt-dlp_macos')).toBeNull();
    expect(await verifyBinary(new TextEncoder().encode('tampered'), sums, 'yt-dlp_macos')).toContain('校验失败');
    expect(await verifyBinary(bytes, sums, 'yt-dlp.exe')).toContain('没有找到');
    expect(await verifyBinary(new Uint8Array(), `${HELLO}  yt-dlp_macos`, 'yt-dlp_macos')).toContain('空');
  });
  it('版本比较', () => {
    expect(isNewerVersion('2026.10.21', '2026.9.3')).toBe(true);
    expect(isNewerVersion('2026.10.21', '2026.10.21')).toBe(false);
    expect(isNewerVersion('2026.10.21.123456', '2026.10.21')).toBe(true);
    expect(isNewerVersion('2026.1.5', '2026.10.21')).toBe(false);
  });
});

describe('显示格式', () => {
  it('大小与时长', () => {
    expect(formatBytes(0)).toBe('未知大小');
    expect(formatBytes(52_428_800)).toBe('50.0 MB');
    expect(formatDuration(312)).toBe('5:12');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(0)).toBe('');
  });
});
