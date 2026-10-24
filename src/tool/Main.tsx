// 主界面：引擎（yt-dlp）状态、粘贴链接、选择清晰度、下载进度。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, CheckCircle2, Download, FolderOpen, Link2, Loader2, RefreshCw, Search, Square, Trash2, Upload, X } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { pickFolder, reveal, settingsStore } from '../kit/platform';
import { MAX_LINKS, formatBytes, formatDuration, isNewerVersion, parseLinks, qualityOptions, type DownloadState } from './core';
import { downloadVideo, fetchInfo } from './flow';
import { SAMPLE_ITEMS, type Item } from './samples';
import { defaultSaveDir, downloadYtdlp, isInstalled, latestVersion, makeDeps, useLocalYtdlp, ytdlpVersion } from './ytdlp';
import './tool.css';

type Ctx = Parameters<CustomTool['Main']>[0]['ctx'];
const PREVIEW = typeof location !== 'undefined' && location.pathname.endsWith('preview.html');
const KEY = 'custom.c29';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
let seq = 0;

type Engine =
  | { s: 'checking' }
  | { s: 'missing' }
  | { s: 'installing'; ratio: number }
  | { s: 'ready'; version: string; update?: string }
  | { s: 'broken'; msg: string };

function stageText(st: DownloadState | undefined): string {
  if (!st) return '准备中…';
  if (st.stage === 'merging') return '正在合并 / 转换格式…';
  if (st.stage === 'start') return '正在连接…';
  const seg = st.segments > 1 ? `第 ${st.segments} 段 · ` : '';
  return `${seg}${st.percent.toFixed(1)}%${st.total ? ` · 共 ${st.total}` : ''}${st.speed ? ` · ${st.speed}` : ''}${st.eta ? ` · 剩余 ${st.eta}` : ''}`;
}

export function Main(_props: { ctx?: Ctx }) {
  const [engine, setEngine] = useState<Engine>(PREVIEW ? { s: 'ready', version: '2026.10.21' } : { s: 'checking' });
  const [engineMsg, setEngineMsg] = useState('');
  const [batch, setBatch] = useState(PREVIEW);
  const [text, setText] = useState(PREVIEW ? '' : '');
  const [items, setItems] = useState<Item[]>(PREVIEW ? SAMPLE_ITEMS : []);
  const [outDir, setOutDir] = useState(PREVIEW ? '/Users/demo/Downloads/全网视频下载器' : '');
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const abort = useRef<AbortController | null>(null);
  const itemsRef = useRef<Item[]>(items);
  itemsRef.current = items;

  const patch = useCallback((id: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

  // 初始化：读保存目录、检查 yt-dlp
  useEffect(() => {
    if (PREVIEW) return;
    void (async () => {
      const saved = await settingsStore().then((s) => s.get<{ outDir?: string }>(KEY)).catch(() => null);
      setOutDir(saved?.outDir || (await defaultSaveDir()));
      await refreshEngine();
    })();
  }, []);

  const refreshEngine = async () => {
    try {
      if (!(await isInstalled())) return setEngine({ s: 'missing' });
      setEngine({ s: 'ready', version: await ytdlpVersion() });
    } catch (e) {
      setEngine({ s: 'broken', msg: errText(e) });
    }
  };

  const saveOutDir = (dir: string) => {
    setOutDir(dir);
    void settingsStore().then((s) => s.set(KEY, { outDir: dir })).catch(() => {});
  };

  const install = async () => {
    setEngine({ s: 'installing', ratio: 0 });
    setEngineMsg('');
    try {
      await downloadYtdlp((ratio) => setEngine({ s: 'installing', ratio }));
      setEngine({ s: 'ready', version: await ytdlpVersion() });
      setEngineMsg('已下载并通过官方 SHA2-256SUMS 校验');
    } catch (e) {
      setEngineMsg(errText(e));
      await refreshEngine();
    }
  };

  const checkUpdate = async () => {
    if (engine.s !== 'ready') return;
    setEngineMsg('正在查询最新版本…');
    try {
      const latest = await latestVersion();
      const has = isNewerVersion(latest, engine.version);
      setEngine({ ...engine, update: has ? latest : undefined });
      setEngineMsg(has ? `发现新版本 ${latest}` : `已是最新版本（${engine.version}）`);
    } catch (e) {
      setEngineMsg(errText(e));
    }
  };

  const pickLocal = async () => {
    const p = await openDialog({ multiple: false, filters: [{ name: 'yt-dlp 程序', extensions: ['exe', ''] }] }).catch(() => null);
    if (typeof p !== 'string') return;
    setEngineMsg('正在复制到应用数据目录…');
    try {
      await useLocalYtdlp(p);
      setEngine({ s: 'ready', version: await ytdlpVersion() });
      setEngineMsg('已使用你选择的 yt-dlp');
    } catch (e) {
      setEngineMsg(`这个文件不能用：${errText(e)}`);
      await refreshEngine();
    }
  };

  // ---- 解析 ----
  const parse = async () => {
    const { urls, invalid, skipped } = parseLinks(batch ? text : text.split(/\s+/)[0] ?? '');
    const msgs: string[] = [];
    if (invalid.length) msgs.push(`${invalid.length} 项不是 http(s) 链接，已忽略`);
    if (skipped) msgs.push(`一次最多 ${MAX_LINKS} 个链接，${skipped} 个未加入`);
    setNotice(msgs.join('；'));
    const fresh = urls.filter((u) => !itemsRef.current.some((x) => x.url === u));
    if (!fresh.length) {
      if (urls.length) setNotice((n) => [n, '这些链接已经在列表里'].filter(Boolean).join('；'));
      return;
    }
    const added: Item[] = fresh.map((url) => ({ id: `v${Date.now().toString(36)}${seq++}`, url, status: 'parsing', quality: 'best' }));
    setItems((xs) => [...xs, ...added]);
    setText('');
    const deps = await makeDeps();
    for (const it of added) {
      try {
        const info = await fetchInfo(deps, it.url);
        patch(it.id, { status: 'ready', info });
      } catch (e) {
        patch(it.id, { status: 'error', error: errText(e) });
      }
    }
  };

  // ---- 下载（一次只下一个） ----
  const start = async () => {
    const todo = itemsRef.current.filter((x) => x.status === 'ready' && x.info);
    if (!todo.length) return;
    setRunning(true);
    setNotice('');
    const ac = new AbortController();
    abort.current = ac;
    const deps = await makeDeps();
    let ok = 0;
    let fail = 0;
    for (const it of todo) {
      if (ac.signal.aborted) break;
      const q = qualityOptions(it.info!).find((o) => o.id === it.quality) ?? qualityOptions(it.info!)[0];
      patch(it.id, { status: 'downloading', state: undefined, error: undefined });
      try {
        const r = await downloadVideo(deps, { url: it.url, outDir, quality: q }, (state) => patch(it.id, { state }), ac.signal);
        patch(it.id, { status: 'done', outPath: r.path, size: r.size });
        ok++;
      } catch (e) {
        if (ac.signal.aborted) patch(it.id, { status: 'ready' });
        else {
          patch(it.id, { status: 'error', error: errText(e) });
          fail++;
        }
      }
    }
    setRunning(false);
    abort.current = null;
    setNotice(ac.signal.aborted ? '已取消，未完成的可以再点「开始下载」' : `完成 ${ok} 个${fail ? `，失败 ${fail} 个，原因见列表` : ''}`);
  };

  const readyCount = items.filter((x) => x.status === 'ready').length;
  const canParse = engine.s === 'ready' && !running && parseLinks(text).urls.length > 0;
  const stats = useMemo(() => ({ done: items.filter((x) => x.status === 'done').length }), [items]);

  return (
    <div className="vd-root">
      <div className="vd-warn" role="note">
        <AlertTriangle size={16} aria-hidden />
        <span>只下载你自己有权使用的内容，并遵守各网站的服务条款与当地法律。需要登录、会员或付费才能看的内容不支持。</span>
      </div>

      <section className="k-panel vd-engine" aria-label="下载引擎">
        <div className="vd-engine-main">
          <b>下载引擎 yt-dlp</b>
          {engine.s === 'checking' && <span className="k-muted"><Loader2 size={14} className="k-spin" /> 检查中…</span>}
          {engine.s === 'missing' && <span className="k-muted">还没有下载。首次使用需要从 yt-dlp 官方 GitHub 发布页下载（约 30–40 MB），不随安装包附带。</span>}
          {engine.s === 'installing' && <span className="k-muted"><Loader2 size={14} className="k-spin" /> 下载中 {Math.round(engine.ratio * 100)}%（完成后校验官方 SHA2-256SUMS）</span>}
          {engine.s === 'ready' && <span className="vd-ok"><CheckCircle2 size={14} /> 已就绪 · 版本 <span className="k-num">{engine.version}</span></span>}
          {engine.s === 'broken' && <span className="k-err-text">无法运行：{engine.msg}</span>}
        </div>
        <div className="vd-engine-actions">
          {(engine.s === 'missing' || engine.s === 'broken') && <button className="k-btn primary" onClick={install}><Download size={15} />下载 yt-dlp</button>}
          {engine.s === 'ready' && !engine.update && <button className="k-btn" onClick={checkUpdate} disabled={running}><RefreshCw size={15} />检查更新</button>}
          {engine.s === 'ready' && engine.update && <button className="k-btn primary" onClick={install} disabled={running}><Download size={15} />更新到 {engine.update}</button>}
          {engine.s !== 'installing' && engine.s !== 'checking' && <button className="k-btn" onClick={pickLocal} disabled={running}><Upload size={15} />手动选择本地 yt-dlp</button>}
        </div>
        {engineMsg && <div className="vd-engine-msg k-help" role="status">{engineMsg}</div>}
      </section>

      <section className="k-panel vd-input" aria-label="粘贴链接">
        <div className="vd-input-head">
          <label className="k-toggle" title="默认关闭：一次只解析一个链接；打开后可一次粘贴多个，依次下载（同一时间只下一个）">
            <input type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} disabled={running} />
            <span>批量模式</span>
          </label>
          <span className="k-help">{batch ? `每行一个链接，最多 ${MAX_LINKS} 个，依次下载` : '粘贴一个视频页面的链接'}</span>
        </div>
        <div className="vd-input-row">
          {batch ? (
            <textarea className="k-textarea" rows={3} aria-label="视频链接（每行一个）" placeholder={'https://example.com/video/1\nhttps://example.com/video/2'} value={text} onChange={(e) => setText(e.target.value)} />
          ) : (
            <div className="k-input-wrap vd-one"><Link2 size={15} aria-hidden /><input className="k-input" aria-label="视频链接" placeholder="https://example.com/video/..." value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && canParse && void parse()} /></div>
          )}
          <button className="k-btn primary" onClick={parse} disabled={!canParse}><Search size={15} />解析</button>
        </div>
        {engine.s !== 'ready' && engine.s !== 'checking' && <div className="k-help">需要先下载 yt-dlp 才能解析链接。</div>}
      </section>

      {notice && <div className="vd-notice" role="status">{notice}</div>}

      <section className="vd-list" aria-label="下载列表">
        {items.length === 0 && <div className="vd-empty k-muted">解析后的视频会出现在这里，可以为每个视频选择清晰度。</div>}
        {items.map((it) => {
          const opts = it.info ? qualityOptions(it.info) : [];
          const q = opts.find((o) => o.id === it.quality);
          return (
            <article key={it.id} className={`k-panel vd-item ${it.status}`}>
              <div className="vd-item-main">
                <div className="vd-title k-ellipsis" title={it.info?.title ?? it.url}>{it.info?.title ?? it.url}</div>
                <div className="vd-sub k-muted k-ellipsis">
                  {it.info ? `${[it.info.site, formatDuration(it.info.duration), it.info.uploader].filter(Boolean).join(' · ')} · ` : ''}{it.url}
                </div>
                {it.status === 'parsing' && <div className="vd-state k-muted"><Loader2 size={14} className="k-spin" /> 正在解析…</div>}
                {it.status === 'downloading' && (
                  <div className="vd-state">
                    <div className="vd-bar" role="progressbar" aria-valuenow={Math.round(it.state?.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${it.state?.percent ?? 0}%` }} /></div>
                    <span className="k-num k-muted">{stageText(it.state)}</span>
                  </div>
                )}
                {it.status === 'done' && <div className="vd-state vd-ok"><CheckCircle2 size={14} style={{ flex: 'none' }} /> <span style={{ whiteSpace: 'nowrap' }}>已保存{it.size ? ` · ${formatBytes(it.size)}` : ''}</span><span className="k-muted k-ellipsis"> · {it.outPath}</span></div>}
                {it.status === 'error' && <div className="vd-state k-err-text" role="alert">{it.error}</div>}
              </div>
              <div className="vd-item-side">
                {it.info && (it.status === 'ready' || it.status === 'error') && (
                  <label className="vd-q"><span className="k-label">清晰度</span>
                    <select className="k-input" value={it.quality} onChange={(e) => patch(it.id, { quality: e.target.value })} disabled={running}>
                      {opts.map((o) => <option key={o.id} value={o.id}>{o.label}{o.size ? `（约 ${formatBytes(o.size)}）` : ''}</option>)}
                    </select>
                  </label>
                )}
                {it.status === 'done' && it.info && <span className="k-st ok">{q?.label ?? ''}</span>}
                {it.status === 'done' && it.outPath && <button className="k-btn" onClick={() => void reveal(it.outPath!)}><FolderOpen size={15} />在文件夹中显示</button>}
                {it.status === 'error' && it.info && <button className="k-btn" disabled={running} onClick={() => patch(it.id, { status: 'ready', error: undefined })}><RefreshCw size={15} />重试</button>}
                {it.status !== 'downloading' && <button className="k-icon-btn" aria-label="移除" title="移除" disabled={running} onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))}><X size={16} /></button>}
              </div>
            </article>
          );
        })}
      </section>

      <footer className="vd-foot">
        <div className="vd-out">
          <span className="k-label">保存到</span>
          <button className="k-input k-folder" disabled={running} onClick={async () => { const p = await pickFolder(); if (p) saveOutDir(p); }}>
            <span>{outDir || '默认：下载 / 全网视频下载器'}</span><FolderOpen size={14} />
          </button>
        </div>
        <span className="vd-sp" />
        {stats.done > 0 && !running && <button className="k-btn ghost" onClick={() => setItems((xs) => xs.filter((x) => x.status !== 'done'))}><Trash2 size={15} />清除已完成</button>}
        {running
          ? <button className="k-btn big" onClick={() => abort.current?.abort()}><Square size={15} />取消</button>
          : <button className="k-btn primary big" onClick={start} disabled={readyCount === 0 || engine.s !== 'ready'}><Download size={16} />开始下载{readyCount ? `（${readyCount}）` : ''}</button>}
      </footer>
    </div>
  );
}
