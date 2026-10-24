// 工具声明：全网视频下载器（自定义界面）。下载核心是 yt-dlp，首次使用时从官方发布页下载，不随安装包附带。
import { Download as DownloadIcon } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'c29',
  name: '全网视频下载器',
  tagline: '粘贴视频链接，选清晰度，下载到本地。基于 yt-dlp，只下载你有权使用的内容；需要登录的内容不支持。',
  icon: DownloadIcon,
  category: '内容生产',
  type: 'media',
  mode: 'custom',
  mainLabel: '下载',
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
