// 流程测试：用假的 yt-dlp 执行器和假的网络，不访问网络、不执行真实程序。
import { describe, expect, it } from 'vitest';
import { downloadVideo, fetchInfo, installYtdlp, type InstallDeps, type RunResult, type YtdlpDeps } from './flow';
import { qualityOptions, sha256Hex } from './core';
import { SAMPLE_INFO_JSON } from './samples';

const fake = (lines: [string, 'out' | 'err'][], code: number, sizes: Record<string, number> = {}): YtdlpDeps & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    ffmpegPath: '/app/ffmpeg',
    fileSize: async (p) => sizes[p] ?? -1,
    async run(args, onLine): Promise<RunResult> {
      calls.push(args);
      const stdout: string[] = [];
      const stderr: string[] = [];
      for (const [l, s] of lines) {
        onLine(l, s);
        (s === 'out' ? stdout : stderr).push(l);
      }
      return { code, stdout, stderr };
    },
  };
};

const best = { id: 'best', label: '最佳画质', selector: 'bv*+ba/b', audioOnly: false, size: 0 };

describe('解析链接', () => {
  it('成功', async () => {
    const d = fake([[SAMPLE_INFO_JSON, 'out']], 0);
    const info = await fetchInfo(d, 'https://example.com/v');
    expect(info.heights).toEqual([1080, 720, 360]);
    expect(d.calls[0]).toContain('-J');
  });
  it('失败时抛出带原因的错误', async () => {
    const d = fake([['ERROR: [generic] x: Sign in to view', 'err']], 1);
    await expect(fetchInfo(d, 'https://example.com/v')).rejects.toThrow(/不处理登录/);
  });
});

describe('下载', () => {
  const lines: [string, 'out' | 'err'][] = [
    ['[download] Destination: /o/t [x].f1.mp4', 'out'],
    ['[download]  50.0% of   10.00MiB at    2.00MiB/s ETA 00:02', 'out'],
    ['[download] 100% of   10.00MiB in 00:00:05 at 2.00MiB/s', 'out'],
    ['[Merger] Merging formats into "/o/t [x].mp4"', 'out'],
  ];
  it('进度回调、校验通过', async () => {
    const d = fake(lines, 0, { '/o/t [x].mp4': 2048 });
    const percents: number[] = [];
    const r = await downloadVideo(d, { url: 'https://example.com/v', outDir: '/o', quality: best }, (s) => percents.push(s.percent));
    expect(r).toEqual({ path: '/o/t [x].mp4', size: 2048 });
    expect(percents).toContain(50);
    expect(percents.at(-1)).toBe(100);
    expect(d.calls[0]).toEqual(expect.arrayContaining(['--ffmpeg-location', '/app/ffmpeg', '-P', '/o']));
  });
  it('文件没有生成时报错', async () => {
    const d = fake(lines, 0, {});
    await expect(downloadVideo(d, { url: 'https://example.com/v', outDir: '/o', quality: best }, () => {})).rejects.toThrow('输出文件不存在');
  });
  it('退出码非 0 时给出 yt-dlp 的错误原因', async () => {
    const d = fake([['ERROR: [generic] n: HTTP Error 404: File not found', 'err']], 1);
    await expect(downloadVideo(d, { url: 'https://example.com/v', outDir: '/o', quality: best }, () => {})).rejects.toThrow(/不存在.*404/);
  });
  it('相对路径补全为绝对路径', async () => {
    const d = fake([['[download] Destination: a.mp4', 'out']], 0, { '/o/a.mp4': 5 });
    expect((await downloadVideo(d, { url: 'https://example.com/v', outDir: '/o/', quality: qualityOptions({ id: '', title: '', duration: 0, uploader: '', site: '', heights: [], hasAudio: false, formats: [] })[0] }, () => {})).path).toBe('/o/a.mp4');
  });
});

describe('安装 yt-dlp', () => {
  const body = new TextEncoder().encode('fake-binary');
  const mk = async (tamper = false) => {
    const sums = `${await sha256Hex(body)}  yt-dlp_macos\n`;
    const log: string[] = [];
    const installed: Uint8Array[] = [];
    const deps: InstallDeps = {
      async fetchText(url) { log.push(url); return sums; },
      async fetchBytes(url, progress) { log.push(url); progress(1); return tamper ? new TextEncoder().encode('evil') : body; },
      async install(b) { installed.push(b); },
    };
    return { deps, log, installed };
  };
  it('校验通过才写入，地址是官方 release', async () => {
    const { deps, log, installed } = await mk();
    await installYtdlp(deps, 'yt-dlp_macos', () => {});
    expect(installed).toHaveLength(1);
    expect(log).toEqual([
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
    ]);
  });
  it('校验失败不写入', async () => {
    const { deps, installed } = await mk(true);
    await expect(installYtdlp(deps, 'yt-dlp_macos', () => {})).rejects.toThrow('校验失败');
    expect(installed).toHaveLength(0);
  });
});
