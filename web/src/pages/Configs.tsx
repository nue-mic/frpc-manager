import { useEffect, useState, useRef } from 'react';
import type { ComponentProps } from 'react';
import {
  Card, Row, Col, Button, Badge, Space, Typography, Popconfirm,
  Tabs, Form, Input, InputNumber, Switch, Table, Drawer, Modal,
  message, Tag, Tooltip, Empty, List, Skeleton, Radio, Select, Dropdown,
  theme as antdTheme,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  DeleteOutlined,
  CopyOutlined,
  EditOutlined,
  CodeOutlined,
  PlusOutlined,
  CheckCircleOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  DownOutlined,
  ApiOutlined,
} from '@ant-design/icons';

const LIST_COMPACT_KEY = 'frpmgr_configs_compact';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';

// 密钥类输入框：默认以「明文」展示，点击右侧眼睛图标后才隐藏（与 antd 默认行为相反）。
// 通过受控 visibilityToggle 把初始可见性设为 true，并透传 Form.Item 注入的 value/onChange 等 props。
function RevealablePassword(props: ComponentProps<typeof Input.Password>) {
  const [visible, setVisible] = useState(true);
  return (
    <Input.Password
      {...props}
      visibilityToggle={{ visible, onVisibleChange: setVisible }}
    />
  );
}

// 与 VS Code 默认 monospace 字体栈对齐：Windows 优先 Cascadia, macOS 退回 SF Mono / Menlo,
// Linux 退回 Ubuntu / DejaVu。任何系统都不会再触发浏览器丑陋的 fallback。
const VSCODE_MONO = `'Cascadia Code', 'Cascadia Mono', Consolas, 'SF Mono', Menlo, Monaco, 'Roboto Mono', 'Fira Code', 'JetBrains Mono', 'Source Code Pro', 'Liberation Mono', 'Courier New', monospace`;

const tomlEditorFontTheme = EditorView.theme({
  '&': { fontFamily: VSCODE_MONO, fontSize: '13.5px' },
  '.cm-content': { fontFamily: VSCODE_MONO, fontVariantLigatures: 'contextual', caretColor: '#fff' },
  '.cm-gutters': { fontFamily: VSCODE_MONO, fontSize: '12.5px' },
  '.cm-scroller': { lineHeight: '1.55' },
});
import client, { getAPIToken } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import { useEventSubscription } from '../events/EventStreamContext';
import type { InstanceStateData } from '../events/types';

const { Title, Text } = Typography;

interface ConfigItem {
  id: string;
  name?: string;
  serverAddr?: string;
  serverPort?: number;
  state?: string; // started, stopped, starting, stopping, error
  manualStart?: boolean;
}

const Configs: React.FC = () => {
  const { token } = antdTheme.useToken();
  const { resolved: themeMode } = useTheme();
  const tomlExtensions = [StreamLanguage.define(toml), tomlEditorFontTheme];
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string>('');
  const [statusLoading, setStatusLoading] = useState<Record<string, boolean>>({});

  // 选项卡状态
  const [activeTab, setActiveTab] = useState<string>('proxies');

  // 配置详情表单状态与数据
  const [detailConfig, setDetailConfig] = useState<any>(null);
  const [rawToml, setRawToml] = useState<string>('');
  const [tomlLoading, setTomlLoading] = useState<boolean>(false);

  // 代理列表状态
  const [proxies, setProxies] = useState<any[]>([]);
  const [proxiesLoading, setProxiesLoading] = useState<boolean>(false);
  const [proxyDrawerOpen, setProxyDrawerOpen] = useState<boolean>(false);
  const [editingProxy, setEditingProxy] = useState<any>(null);

  // 迷你日志状态（最近 1000 行 + 实时 WebSocket 推送 + 自动滚底）
  const MINI_LOGS_MAX = 1000;
  const [miniLogLines, setMiniLogLines] = useState<string[]>([]);
  const [miniLogsLoading, setMiniLogsLoading] = useState<boolean>(false);
  const [miniLogsPaused, setMiniLogsPaused] = useState<boolean>(false);
  const [miniLogsWsState, setMiniLogsWsState] = useState<'idle' | 'connecting' | 'connected' | 'closed'>('idle');
  const miniLogsPausedRef = useRef(miniLogsPaused);
  miniLogsPausedRef.current = miniLogsPaused;
  const miniLogsWsRef = useRef<WebSocket | null>(null);
  const miniLogsBottomRef = useRef<HTMLDivElement | null>(null);

  // 新建配置 Modal
  const [newConfigModalOpen, setNewConfigModalOpen] = useState<boolean>(false);

  // 左栏紧凑模式（保存到 localStorage）— 常用右栏时把列表折成窄条
  const [compactList, setCompactList] = useState<boolean>(
    () => localStorage.getItem(LIST_COMPACT_KEY) === '1'
  );
  const toggleCompactList = () => {
    setCompactList((prev) => {
      const next = !prev;
      localStorage.setItem(LIST_COMPACT_KEY, next ? '1' : '0');
      return next;
    });
  };

  const [form] = Form.useForm();
  const [proxyForm] = Form.useForm();
  const [newConfigForm] = Form.useForm();

  useEffect(() => {
    fetchConfigs();
  }, []);

  useEffect(() => {
    if (activeConfigId) {
      handleLoadConfigDetails(activeConfigId);
    }
  }, [activeConfigId, activeTab]);

  const fetchConfigs = async () => {
    try {
      const resp = await client.get('/api/v1/configs');
      if (resp.status === 200) {
        const items = resp.data?.items || resp.data || [];
        setConfigs(items);
        if (items.length > 0 && !activeConfigId) {
          setActiveConfigId(items[0].id);
        }
      }
    } catch (err) {
      message.error('无法获取配置列表');
    }
  };

  const fetchStatus = async (id: string) => {
    try {
      const resp = await client.get(`/api/v1/configs/${id}/status`);
      if (resp.status === 200) {
        const state = resp.data?.state || 'stopped';
        setConfigs(prev => prev.map(c => c.id === id ? { ...c, state: state } : c));
      }
    } catch (err) {
      // 忽略状态请求错误
    }
  };

  // 实时同步配置引用，规避 React 经典闭包陷阱
  const configsRef = useRef(configs);
  useEffect(() => {
    configsRef.current = configs;
  }, [configs]);

  // 轮询状态
  useEffect(() => {
    // 首次载入时，如果已有配置，立即刷新一次状态
    if (configsRef.current && configsRef.current.length > 0) {
      configsRef.current.forEach(c => {
        fetchStatus(c.id);
      });
    }

    // 启动定时器，每 4 秒轮询一次当前所有的实例状态
    const timer = setInterval(() => {
      if (configsRef.current && configsRef.current.length > 0) {
        configsRef.current.forEach(c => {
          fetchStatus(c.id);
        });
      }
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  // 事件驱动自动刷新：后端热更新（增删改代理后 reload）、实例启停、代理状态
  // 变化时实时刷新页面，无需手动刷新或等 4 秒轮询。
  //
  // 闭包说明：useEventSubscription 内部用 ref 持有最新回调，回调体里引用的
  // activeConfigId / loadProxies 始终是最新值，无闭包陷阱。但防抖定时器的
  // 回调延迟到 300ms 后才执行，那时再用 ref 取「当前是否仍在查看该配置」，
  // 避免用户已切走却刷错配置。
  const activeConfigIdRef = useRef(activeConfigId);
  activeConfigIdRef.current = activeConfigId;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const proxyReloadTimer = useRef<number | null>(null);

  const scheduleProxyReload = (id: string) => {
    if (proxyReloadTimer.current != null) clearTimeout(proxyReloadTimer.current);
    proxyReloadTimer.current = window.setTimeout(() => {
      proxyReloadTimer.current = null;
      // 仅当用户仍停留在该配置的「代理」Tab 时才重拉，省掉无意义的请求
      if (activeConfigIdRef.current === id && activeTabRef.current === 'proxies') {
        loadProxies(id);
      }
    }, 300);
  };

  // 不订阅 proxy.connections：它每 2 秒高频推送，会导致频繁整列表重拉。
  useEventSubscription(['config.changed', 'proxy.status', 'instance.state'], (e) => {
    // 实例启停 → 实时更新顶部运行徽标（补足 4 秒轮询的延迟）
    if (e.type === 'instance.state' && e.config_id) {
      const st = (e.data as InstanceStateData | undefined)?.state;
      if (st) {
        setConfigs(prev => prev.map(c => (c.id === e.config_id ? { ...c, state: st } : c)));
      }
    }
    // 当前正在查看的配置 → 防抖合并连发事件后刷新代理列表（状态列同步更新）
    if (e.config_id && e.config_id === activeConfigId) {
      scheduleProxyReload(e.config_id);
    }
  });

  // 卸载时清掉挂起的防抖定时器，避免组件已卸载仍触发 loadProxies
  useEffect(() => () => {
    if (proxyReloadTimer.current != null) clearTimeout(proxyReloadTimer.current);
  }, []);

  const handleStartInstance = async (id: string) => {
    setStatusLoading(prev => ({ ...prev, [id]: true }));
    try {
      await client.post(`/api/v1/configs/${id}/start`);
      message.success('启动指令已发送');
      fetchStatus(id);
    } catch (err: any) {
      message.error('启动失败: ' + (err.response?.data?.error?.message || err.message));
    } finally {
      setStatusLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleStopInstance = async (id: string) => {
    setStatusLoading(prev => ({ ...prev, [id]: true }));
    try {
      await client.post(`/api/v1/configs/${id}/stop`);
      message.success('停止指令已发送');
      fetchStatus(id);
    } catch (err: any) {
      message.error('停止失败: ' + (err.response?.data?.error?.message || err.message));
    } finally {
      setStatusLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleReloadInstance = async (id: string) => {
    setStatusLoading(prev => ({ ...prev, [id]: true }));
    try {
      await client.post(`/api/v1/configs/${id}/reload`);
      message.success('配置已重载');
    } catch (err: any) {
      message.error('重载失败: ' + (err.response?.data?.error?.message || err.message));
    } finally {
      setStatusLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleDeleteConfig = async (id: string) => {
    try {
      await client.delete(`/api/v1/configs/${id}`);
      message.success('配置已删除');
      if (activeConfigId === id) {
        setActiveConfigId('');
      }
      fetchConfigs();
    } catch (err) {
      message.error('删除配置失败');
    }
  };

  const handleDuplicateConfig = async (id: string) => {
    const newId = `${id}_copy`;
    try {
      await client.post(`/api/v1/configs/${id}/duplicate`, { new_id: newId });
      message.success(`已复制为新配置: ${newId}`);
      fetchConfigs();
    } catch (err: any) {
      message.error('复制失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 导出单个配置为 TOML 文件并触发浏览器下载
  const handleExportConfig = async (id: string) => {
    try {
      const resp = await client.get(`/api/v1/configs/${id}/export`, { responseType: 'blob' });
      const blob = new Blob([resp.data], { type: 'application/toml' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${id}.toml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      message.success(`已导出 ${id}.toml`);
    } catch (err: any) {
      message.error('导出失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 构造右键菜单（在两种 Card 渲染分支之间共用）
  const buildContextMenu = (item: ConfigItem): MenuProps => {
    const isRunning = item.state === 'started';
    return {
      items: [
        isRunning
          ? { key: 'stop', label: '停止', icon: <StopOutlined /> }
          : { key: 'start', label: '启动', icon: <PlayCircleOutlined /> },
        { key: 'reload', label: '重载配置', icon: <ReloadOutlined />, disabled: !isRunning },
        { type: 'divider' },
        { key: 'duplicate', label: '克隆配置', icon: <CopyOutlined /> },
        { key: 'export', label: '导出 TOML', icon: <DownloadOutlined /> },
        { type: 'divider' },
        {
          key: 'delete',
          label: '删除配置',
          icon: <DeleteOutlined />,
          danger: true,
        },
      ],
      onClick: ({ key, domEvent }) => {
        domEvent.stopPropagation();
        switch (key) {
          case 'start':
            handleStartInstance(item.id);
            break;
          case 'stop':
            handleStopInstance(item.id);
            break;
          case 'reload':
            handleReloadInstance(item.id);
            break;
          case 'duplicate':
            handleDuplicateConfig(item.id);
            break;
          case 'export':
            handleExportConfig(item.id);
            break;
          case 'delete':
            Modal.confirm({
              title: `确定删除「${item.name || item.id}」？`,
              icon: <ExclamationCircleOutlined />,
              content: '删除后相关代理 / 访客规则一并抹去且无法恢复。',
              okText: '删除',
              okType: 'danger',
              cancelText: '取消',
              onOk: () => handleDeleteConfig(item.id),
            });
            break;
        }
      },
    };
  };

  // 根据当前 Tab 加载对应数据
  const handleLoadConfigDetails = async (id: string) => {
    if (activeTab === 'proxies') {
      loadProxies(id);
    } else if (activeTab === 'visual') {
      loadVisualConfig(id);
    } else if (activeTab === 'toml') {
      loadRawToml(id);
    } else if (activeTab === 'logs') {
      loadMiniLogs(id);
    }
  };

  // 加载代理 + 访客列表
  //
  // 后端 /proxies 返回的是「运行时快照」（ProxySnapshot, snake_case），只含
  //   name / type / status / local_ip / local_port / cur_conns / disabled
  // 不含 remotePort / customDomains / secretKey / multiplexer 等业务字段。
  // 业务字段需从 GET /configs/{id} 的 config.proxies[] / config.visitors[] (camelCase) 取，按 name 合并。
  //
  // 每条记录加 `_kind: 'proxy' | 'visitor'` 标记 — 后续编辑 / 保存依据它决定走哪条 API 通道
  // （/proxies POST 接受 `{proxy:...}` 或 `{visitor:...}` 两种 envelope）。
  const loadProxies = async (id: string) => {
    setProxiesLoading(true);
    try {
      const [snapResp, envResp] = await Promise.all([
        client.get(`/api/v1/configs/${id}/proxies`),
        client.get(`/api/v1/configs/${id}`),
      ]);
      const snapItems: any[] = snapResp.data?.items || [];
      const fullProxies: any[] = envResp.data?.config?.proxies || [];
      const fullVisitors: any[] = envResp.data?.config?.visitors || [];
      const proxyByName = new Map(fullProxies.map((p: any) => [p.name, p]));
      const visitorByName = new Map(fullVisitors.map((v: any) => [v.name, v]));
      const merged = snapItems.map((snap) => {
        if (visitorByName.has(snap.name)) {
          return { _kind: 'visitor', ...(visitorByName.get(snap.name) || {}), ...snap };
        }
        return { _kind: 'proxy', ...(proxyByName.get(snap.name) || {}), ...snap };
      });
      setProxies(merged);
    } catch (err) {
      setProxies([]);
    } finally {
      setProxiesLoading(false);
    }
  };

  // 切换代理开关
  const handleToggleProxy = async (proxyName: string, enabled: boolean) => {
    try {
      await client.post(`/api/v1/configs/${activeConfigId}/proxies/${proxyName}/toggle`, { enabled });
      message.success(`${proxyName} 状态已更新`);
      loadProxies(activeConfigId);
    } catch (err) {
      message.error('修改代理状态失败');
    }
  };

  // 删除代理
  const handleDeleteProxy = async (proxyName: string) => {
    try {
      await client.delete(`/api/v1/configs/${activeConfigId}/proxies/${proxyName}`);
      message.success('代理规则已删除');
      loadProxies(activeConfigId);
    } catch (err) {
      message.error('删除代理失败');
    }
  };

  // 加载常规属性
  const loadVisualConfig = async (id: string) => {
    try {
      const resp = await client.get(`/api/v1/configs/${id}`);
      if (resp.status === 200) {
        const envelope = resp.data || {};
        setDetailConfig(envelope);
        const configData = envelope.config || {};
        // 回填表单
        form.setFieldsValue({
          name: configData.frpmgr?.name || '',
          user: configData.user || '',
          serverAddr: configData.serverAddr || '',
          serverPort: configData.serverPort || 7000,
          natHoleStunServer: configData.natHoleStunServer || '',
          // 注意：后端 loginFailExit 是 *bool（nil/true=登录失败立即退出，false=无限重试）
          // 本项目 NewDefaultClientConfigV1 默认为 false，与上游 frp 不同。
          loginFailExit: configData.loginFailExit ?? false,
          // 开关代表「自启」，与 manualStart 语义相反：manualStart 缺省/false = 自启，
          // 故默认开关为开（autoStart=true）
          autoStart: !(configData.frpmgr?.manualStart ?? false),
          // 认证
          authMethod: configData.auth?.method || 'token',
          authToken: configData.auth?.token || '',
          oidcClientId: configData.auth?.oidc?.clientId || '',
          oidcClientSecret: configData.auth?.oidc?.clientSecret || '',
          oidcAudience: configData.auth?.oidc?.audience || '',
          oidcScope: configData.auth?.oidc?.scope || '',
          oidcTokenEndpoint: configData.auth?.oidc?.tokenEndpointUrl || '',
          // 日志
          logLevel: configData.log?.level || 'info',
          logMaxDays: configData.log?.maxDays || 3,
          // 管理
          adminAddr: configData.webServer?.addr || '',
          adminPort: configData.webServer?.port || undefined,
          adminUser: configData.webServer?.user || '',
          adminPwd: configData.webServer?.password || '',
          assetsDir: configData.webServer?.assetsDir || '',
          pprofEnable: configData.webServer?.pprofEnable ?? false,
          // 连接与TLS
          protocol: configData.transport?.protocol || 'tcp',
          dialServerTimeout: configData.transport?.dialServerTimeout || undefined,
          dialServerKeepAlive: configData.transport?.dialServerKeepAlive || undefined,
          poolCount: configData.transport?.poolCount || undefined,
          tcpMux: configData.transport?.tcpMux ?? true,
          heartbeatInterval: configData.transport?.heartbeatInterval || undefined,
          heartbeatTimeout: configData.transport?.heartbeatTimeout || undefined,
          tlsEnable: configData.transport?.tls?.enable ?? false,
          disableCustomTLSFirstByte: configData.transport?.tls?.disableCustomTLSFirstByte ?? false,
          tlsCertFile: configData.transport?.tls?.certFile || '',
          tlsKeyFile: configData.transport?.tls?.keyFile || '',
          tlsTrustedCaFile: configData.transport?.tls?.trustedCaFile || '',
          tlsServerName: configData.transport?.tls?.serverName || '',
        });
      }
    } catch (err) {
      message.error('获取配置详情失败');
    }
  };

  // 加载 TOML 源码
  const loadRawToml = async (id: string) => {
    setTomlLoading(true);
    try {
      const resp = await client.get(`/api/v1/configs/${id}/raw`);
      if (resp.status === 200) {
        setRawToml(resp.data || '');
      }
    } catch (err) {
      setRawToml('');
    } finally {
      setTomlLoading(false);
    }
  };

  // 关闭实时日志 WebSocket
  const disconnectMiniLogsWS = () => {
    if (miniLogsWsRef.current) {
      try { miniLogsWsRef.current.close(); } catch {/* ignore */}
      miniLogsWsRef.current = null;
    }
    setMiniLogsWsState('closed');
  };

  // 拉取最近 1000 行历史日志，并起 WebSocket 实时尾追
  // 后端 HTTP `/logs?lines=N`（util.ReadFileLines）返回最后 N 行历史；
  // WS `/logs/tail` 每帧 `{line: "..."}` 推送新增行（带 30s ping 保活）。
  const loadMiniLogs = async (id: string) => {
    disconnectMiniLogsWS();
    setMiniLogsLoading(true);
    setMiniLogLines([]);
    try {
      const resp = await client.get(`/api/v1/configs/${id}/logs?lines=${MINI_LOGS_MAX}`);
      if (resp.status === 200) {
        const data = resp.data;
        const lines: string[] = Array.isArray(data?.lines) ? data.lines : (Array.isArray(data) ? data : []);
        setMiniLogLines(lines.slice(-MINI_LOGS_MAX));
      }
    } catch {
      // 日志文件不存在很正常（实例从未启动过）— 静默
    } finally {
      setMiniLogsLoading(false);
    }

    // 起 WebSocket 实时尾追
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const apiToken = getAPIToken();
    const wsUrl = `${protocol}//${window.location.host}/api/v1/configs/${id}/logs/tail?token=${encodeURIComponent(apiToken || '')}`;
    setMiniLogsWsState('connecting');
    try {
      const ws = new WebSocket(wsUrl);
      miniLogsWsRef.current = ws;
      ws.onopen = () => setMiniLogsWsState('connected');
      ws.onmessage = (evt) => {
        if (miniLogsPausedRef.current) return;
        let line: string | null = null;
        try {
          const obj = JSON.parse(evt.data);
          if (obj && typeof obj.line === 'string') line = obj.line;
        } catch {
          if (typeof evt.data === 'string') line = evt.data;
        }
        if (line === null) return;
        setMiniLogLines((prev) => {
          const next = prev.length >= MINI_LOGS_MAX ? prev.slice(prev.length - MINI_LOGS_MAX + 1) : prev.slice();
          next.push(line!);
          return next;
        });
      };
      ws.onerror = () => setMiniLogsWsState('closed');
      ws.onclose = () => setMiniLogsWsState('closed');
    } catch {
      setMiniLogsWsState('closed');
    }
  };

  // 清空日志：调用后端 DELETE 真删日志文件，再清前端缓冲。
  // 注意：日志由运行中的 frpc 持续写入，清空的是「历史」；之后新产生的行仍会实时推送进来。
  const handleClearMiniLogs = async (id: string) => {
    if (!id) return;
    try {
      await client.delete(`/api/v1/configs/${id}/logs`);
      setMiniLogLines([]);
      message.success('日志已清空');
    } catch (err: any) {
      message.error('清空失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // tab 离开 logs / 切换实例 / 组件卸载 时断开 WS，避免泄露与无谓流量
  useEffect(() => {
    if (activeTab !== 'logs') {
      disconnectMiniLogsWS();
    }
    return () => disconnectMiniLogsWS();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeConfigId]);

  // 新行进来时自动滚到底（暂停时不滚）
  useEffect(() => {
    if (miniLogsPaused) return;
    miniLogsBottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [miniLogLines, miniLogsPaused]);

  // 行级颜色 class — 与 Logs.tsx 保持一致，靠 index.css 的 .log-info/.log-warn/.log-error/.log-debug
  const miniLogClass = (line: string): string => {
    if (line.includes('[W]') || /\bwarn(ing)?\b/i.test(line)) return 'log-line log-warn';
    if (line.includes('[E]') || /\berror\b|\bfailed\b/i.test(line)) return 'log-line log-error';
    if (line.includes('[D]') || /\bdebug\b/i.test(line)) return 'log-line log-debug';
    if (line.includes('[I]') || /\binfo\b/i.test(line)) return 'log-line log-info';
    return 'log-line';
  };

  // 保存可视化配置
  const handleSaveVisualConfig = async (values: any) => {
    try {
      const payload = {
        config: {
          ...detailConfig?.config,
          user: values.user || undefined,
          serverAddr: values.serverAddr,
          serverPort: values.serverPort,
          natHoleStunServer: values.natHoleStunServer || undefined,
          // *bool — 必须显式写入（含 false），否则 spread 里旧值会保留
          loginFailExit: values.loginFailExit,
          auth: {
            method: values.authMethod,
            token: values.authMethod === 'token' ? values.authToken : undefined,
            oidc: values.authMethod === 'oidc' ? {
              clientId: values.oidcClientId || undefined,
              clientSecret: values.oidcClientSecret || undefined,
              audience: values.oidcAudience || undefined,
              scope: values.oidcScope || undefined,
              tokenEndpointUrl: values.oidcTokenEndpoint || undefined,
            } : undefined,
          },
          log: {
            level: values.logLevel,
            maxDays: values.logMaxDays || 3,
          },
          webServer: {
            addr: values.adminAddr || undefined,
            port: values.adminPort || undefined,
            user: values.adminUser || undefined,
            password: values.adminPwd || undefined,
            assetsDir: values.assetsDir || undefined,
            pprofEnable: values.pprofEnable ?? false,
          },
          transport: {
            protocol: values.protocol,
            dialServerTimeout: values.dialServerTimeout || undefined,
            dialServerKeepAlive: values.dialServerKeepAlive || undefined,
            poolCount: values.poolCount || undefined,
            tcpMux: values.tcpMux ?? true,
            heartbeatInterval: values.heartbeatInterval || undefined,
            heartbeatTimeout: values.heartbeatTimeout || undefined,
            tls: {
              enable: values.tlsEnable ?? false,
              disableCustomTLSFirstByte: values.disableCustomTLSFirstByte ?? false,
              certFile: values.tlsCertFile || undefined,
              keyFile: values.tlsKeyFile || undefined,
              trustedCaFile: values.tlsTrustedCaFile || undefined,
              serverName: values.tlsServerName || undefined,
            }
          },
          frpmgr: {
            ...(detailConfig?.config?.frpmgr ?? {}),
            name: values.name,
            manualStart: !values.autoStart,
          }
        }
      };
      await client.put(`/api/v1/configs/${activeConfigId}`, payload);
      message.success('配置保存成功！');
      fetchConfigs();
      // 保存后用磁盘最新结果重新回填表单（对账：与后端补全/序列化结果保持一致，
      // 及时暴露异常，避免界面停留在与磁盘不一致的旧值上）
      if (activeConfigId) loadVisualConfig(activeConfigId);
    } catch (err: any) {
      message.error('保存失败: ' + (err.response?.data?.error?.message || err.message || ''));
    }
  };

  // 校验并保存 Raw TOML
  const handleSaveRawToml = async () => {
    setTomlLoading(true);
    try {
      // 语法校验
      const valResp = await client.post('/api/v1/validate', rawToml, {
        headers: { 'Content-Type': 'application/toml' }
      });
      if (valResp.status === 200) {
        // 校验通过，直接保存
        await client.put(`/api/v1/configs/${activeConfigId}/raw`, rawToml, {
          headers: { 'Content-Type': 'application/toml' }
        });
        message.success('TOML 校验并保存成功！');
        fetchConfigs();
      }
    } catch (err: any) {
      message.error('保存失败: ' + (err.response?.data?.error?.message || 'TOML 语法校验未通过'));
    } finally {
      setTomlLoading(false);
    }
  };

  // 新建配置
  const handleCreateConfig = async (values: any) => {
    try {
      const payload = {
        id: values.id,
        config: {
          user: values.user || undefined,
          serverAddr: values.serverAddr || '127.0.0.1',
          serverPort: values.serverPort || 7000,
          auth: {
            method: 'token',
            token: values.token || '',
          },
          frpmgr: {
            name: values.name || values.id,
            // autoStart 开关 → manualStart 取反（默认自启）
            manualStart: !(values.autoStart ?? true),
          }
        }
      };
      await client.post('/api/v1/configs', payload);
      message.success('配置创建成功');
      setNewConfigModalOpen(false);
      newConfigForm.resetFields();
      setActiveConfigId(values.id);
      fetchConfigs();
    } catch (err: any) {
      message.error('创建失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 提交「代理 / 访客」Drawer 表单
  //
  // 根据 values.kind 决定走 envelope 的 `proxy` 还是 `visitor` 通道：
  //   - 'proxy'   → {proxy:   v1.TypedProxyConfig}   全部 8 种协议
  //   - 'visitor' → {visitor: v1.TypedVisitorConfig} 仅 stcp/sudp/xtcp
  const handleSaveProxy = async (rawValues: any) => {
    try {
      // 提交前对所有字符串字段统一去除首尾空格（名称、秘钥、地址等），
      // 避免误输入的空格导致名称冲突、秘钥不匹配或连接失败。
      const values: any = Object.fromEntries(
        Object.entries(rawValues).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
      );
      const splitCSV = (v?: string): string[] | undefined =>
        v ? v.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;
      const kind = (values.kind as 'proxy' | 'visitor') || 'proxy';
      const t = values.type as string;

      let body: Record<string, unknown>;

      if (kind === 'visitor') {
        // visitor 仅适用于 stcp / sudp / xtcp
        const v: Record<string, unknown> = {
          name: values.name,
          type: t,
          secretKey: values.secretKey,
          serverName: values.serverName,
          bindAddr: values.bindAddr || '127.0.0.1',
          bindPort: values.bindPort,
        };
        if (values.serverUser) v.serverUser = values.serverUser;
        if (values.useEncryption !== undefined || values.useCompression !== undefined) {
          v.transport = {
            useEncryption: !!values.useEncryption,
            useCompression: !!values.useCompression,
          };
        }
        if (t === 'xtcp') {
          if (values.xtcpProtocol) v.protocol = values.xtcpProtocol;
          if (values.keepTunnelOpen) v.keepTunnelOpen = true;
          if (values.maxRetriesAnHour) v.maxRetriesAnHour = values.maxRetriesAnHour;
          if (values.minRetryInterval) v.minRetryInterval = values.minRetryInterval;
          if (values.fallbackTo) v.fallbackTo = values.fallbackTo;
          if (values.fallbackTimeoutMs) v.fallbackTimeoutMs = values.fallbackTimeoutMs;
        }
        body = { visitor: v };
      } else {
        const payload: Record<string, unknown> = {
          name: values.name,
          type: t,
          localIP: values.localIP || '127.0.0.1',
          localPort: values.localPort,
        };
        // 通用 / TCP / UDP
        if (t === 'tcp' || t === 'udp') {
          payload.remotePort = values.remotePort;
        }
        // tcpmux：基于域名复用
        if (t === 'tcpmux') {
          payload.multiplexer = values.multiplexer || 'httpconnect';
          payload.customDomains = splitCSV(values.customDomains);
          if (values.routeByHTTPUser) payload.routeByHTTPUser = values.routeByHTTPUser;
        }
        // HTTP / HTTPS
        if (t === 'http' || t === 'https') {
          payload.customDomains = splitCSV(values.customDomains);
          if (values.subdomain) payload.subdomain = values.subdomain;
          if (values.locations) payload.locations = splitCSV(values.locations);
          if (values.hostHeaderRewrite) payload.hostHeaderRewrite = values.hostHeaderRewrite;
          if (values.httpUser) payload.httpUser = values.httpUser;
          if (values.httpPassword) payload.httpPassword = values.httpPassword;
        }
        // STCP / SUDP / XTCP（服务端角色）
        if (t === 'stcp' || t === 'sudp' || t === 'xtcp') {
          payload.secretKey = values.secretKey;
          // allowUsers 留空时默认放行所有用户（*）
          payload.allowUsers = splitCSV(values.allowUsers) ?? ['*'];
        }
        // 插件透传
        if (values.pluginName) {
          const plugin: Record<string, unknown> = { type: values.pluginName };
          if (values.pluginLocalAddr) plugin.localAddr = values.pluginLocalAddr;
          if (values.pluginLocalPath) plugin.localPath = values.pluginLocalPath;
          if (values.pluginHTTPUser) plugin.httpUser = values.pluginHTTPUser;
          if (values.pluginHTTPPassword) plugin.httpPassword = values.pluginHTTPPassword;
          payload.plugin = plugin;
        }
        body = { proxy: payload };
      }

      if (editingProxy) {
        await client.put(`/api/v1/configs/${activeConfigId}/proxies/${editingProxy.name}`, body);
        message.success(`${kind === 'visitor' ? '访客' : '代理'}规则修改成功`);
      } else {
        await client.post(`/api/v1/configs/${activeConfigId}/proxies`, body);
        message.success(`${kind === 'visitor' ? '访客' : '代理'}规则创建成功`);
      }
      setProxyDrawerOpen(false);
      loadProxies(activeConfigId);
    } catch (err: any) {
      message.error('操作失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 随机生成一个「专业、简短、符合大厂规范」的规则名。
  // 规范：全小写 kebab-case，<服务角色>-<协议/区域>-<短随机ID>，参考 AWS/GCP/K8s 资源命名。
  const genRuleName = (): string => {
    const roles = ['web', 'api', 'gw', 'ssh', 'rdp', 'db', 'cache', 'mq', 'file', 'vpn', 'mon', 'log', 'edge', 'sync', 'app'];
    const role = roles[Math.floor(Math.random() * roles.length)];
    // 4 位 base36 短 ID 保证唯一性，又不至于太长
    const id = Math.random().toString(36).slice(2, 6);
    return `${role}-${id}`;
  };

  // 开启 Drawer（新建 / 编辑 / 复制）
  // asCopy=true：以「新建」模式打开，但用源规则数据预填表单、名称换成随机名，
  // 实现「复制添加」——减少重复输入。
  const openProxyDrawer = (proxyItem?: any, initialKind: 'proxy' | 'visitor' = 'proxy', asCopy = false) => {
    // 复制时不进入编辑模式（保证名称可改、提交走 POST 新建）
    setEditingProxy(asCopy ? undefined : proxyItem);
    if (proxyItem) {
      const kind: 'proxy' | 'visitor' = proxyItem._kind || 'proxy';
      const pl = proxyItem.plugin || {};
      proxyForm.setFieldsValue({
        kind,
        name: asCopy ? genRuleName() : proxyItem.name,
        type: proxyItem.type || 'tcp',
        // proxy / server-side 字段
        localIP: proxyItem.localIP || '127.0.0.1',
        localPort: proxyItem.localPort,
        remotePort: proxyItem.remotePort,
        customDomains: proxyItem.customDomains ? proxyItem.customDomains.join(',') : '',
        subdomain: proxyItem.subdomain,
        locations: proxyItem.locations ? proxyItem.locations.join(',') : '',
        hostHeaderRewrite: proxyItem.hostHeaderRewrite,
        httpUser: proxyItem.httpUser,
        httpPassword: proxyItem.httpPassword,
        multiplexer: proxyItem.multiplexer,
        routeByHTTPUser: proxyItem.routeByHTTPUser,
        secretKey: proxyItem.secretKey,
        allowUsers: proxyItem.allowUsers ? proxyItem.allowUsers.join(',') : '',
        pluginName: pl.type,
        pluginLocalAddr: pl.localAddr,
        pluginLocalPath: pl.localPath,
        pluginHTTPUser: pl.httpUser,
        pluginHTTPPassword: pl.httpPassword,
        // visitor 字段
        serverName: proxyItem.serverName,
        serverUser: proxyItem.serverUser,
        bindAddr: proxyItem.bindAddr || '127.0.0.1',
        bindPort: proxyItem.bindPort,
        useEncryption: proxyItem.transport?.useEncryption ?? false,
        useCompression: proxyItem.transport?.useCompression ?? false,
        // xtcp visitor 额外
        xtcpProtocol: proxyItem.protocol || 'quic',
        keepTunnelOpen: proxyItem.keepTunnelOpen ?? false,
        maxRetriesAnHour: proxyItem.maxRetriesAnHour,
        minRetryInterval: proxyItem.minRetryInterval,
        fallbackTo: proxyItem.fallbackTo,
        fallbackTimeoutMs: proxyItem.fallbackTimeoutMs,
      });
    } else {
      proxyForm.resetFields();
      proxyForm.setFieldsValue({
        kind: initialKind,
        type: initialKind === 'visitor' ? 'stcp' : 'tcp',
        localIP: '127.0.0.1',
        bindAddr: '127.0.0.1',
        xtcpProtocol: 'quic',
        allowUsers: '*',
      });
    }
    setProxyDrawerOpen(true);
  };

  const getStatusBadge = (state?: string) => {
    switch (state) {
      case 'started':
        return <Badge status="success" text={<span style={{ color: '#52c41a' }}>正在运行</span>} />;
      case 'error':
        return <Badge status="error" text={<span style={{ color: '#ff4d4f' }}>错误异常</span>} />;
      case 'starting':
        return <Badge status="processing" text={<span style={{ color: '#1677ff' }}>启动中</span>} />;
      case 'stopping':
        return <Badge status="processing" text={<span style={{ color: '#faad14' }}>停止中</span>} />;
      default:
        return <Badge status="default" text={<span>未启动</span>} />;
    }
  };

  return (
    <div style={{ height: '100%' }}>
      <Row gutter={16} style={{ height: '100%', minHeight: '580px' }}>
        {/* 左栏：实例卡片列表（支持紧凑/完整两档宽度，状态持久化在 localStorage） */}
        <Col xs={24} md={compactList ? 5 : 8} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8 }}>
            <Space size={6} style={{ minWidth: 0, flex: 1 }}>
              <Tooltip title={compactList ? '展开列表' : '收起为紧凑列表'}>
                <Button
                  size="small"
                  type="text"
                  icon={compactList ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                  onClick={toggleCompactList}
                />
              </Tooltip>
              {!compactList && <Title level={4} style={{ margin: 0 }}>配置列表</Title>}
            </Space>
            {compactList ? (
              <Tooltip title="新建配置">
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setNewConfigModalOpen(true)}
                />
              </Tooltip>
            ) : (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setNewConfigModalOpen(true)}
              >
                新建配置
              </Button>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
            {configs.length === 0 ? (
              <Card style={{ textAlign: 'center', padding: compactList ? '20px 0' : '40px 0', borderRadius: 10 }}>
                <Empty description={compactList ? '暂无配置' : '暂无配置文件，点击右上角创建。'} />
              </Card>
            ) : (
              <List
                dataSource={configs}
                renderItem={(item) => {
                  const isActive = item.id === activeConfigId;
                  const isRunning = item.state === 'started';

                  // 紧凑模式：只显示名字 + 状态圆点 + 启停按钮，省去 ID 与克隆/删除按钮
                  // 完整功能（重载/克隆/导出/删除）通过右键菜单暴露
                  if (compactList) {
                    return (
                      <Dropdown menu={buildContextMenu(item)} trigger={['contextMenu']}>
                        <Tooltip title={`${item.name || item.id} (ID: ${item.id}) · 右键可重载 / 克隆 / 导出 / 删除`} placement="right">
                          <Card
                            hoverable
                            size="small"
                            data-testid={`config-card-${item.id}`}
                            style={{
                              marginBottom: 8,
                              cursor: 'pointer',
                              border: `1px solid ${isActive ? token.colorPrimary : token.colorBorderSecondary}`,
                              background: isActive ? token.colorPrimaryBg : token.colorBgContainer,
                              borderRadius: 8,
                            }}
                            onClick={() => setActiveConfigId(item.id)}
                            styles={{ body: { padding: '8px 10px' } }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <Badge
                                status={
                                  item.state === 'started' ? 'success'
                                  : item.state === 'error' ? 'error'
                                  : item.state === 'starting' || item.state === 'stopping' ? 'processing'
                                  : 'default'
                                }
                              />
                              <Text strong ellipsis style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                                {item.name || item.id}
                              </Text>
                              <Button
                                size="small"
                                type="text"
                                icon={isRunning ? <StopOutlined /> : <PlayCircleOutlined />}
                                loading={statusLoading[item.id]}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  isRunning ? handleStopInstance(item.id) : handleStartInstance(item.id);
                                }}
                                style={{
                                  color: isRunning ? token.colorError : token.colorSuccess,
                                }}
                              />
                            </div>
                          </Card>
                        </Tooltip>
                      </Dropdown>
                    );
                  }

                  return (
                    <Dropdown menu={buildContextMenu(item)} trigger={['contextMenu']}>
                    <Card
                      hoverable
                      data-testid={`config-card-${item.id}`}
                      style={{
                        marginBottom: 12,
                        cursor: 'pointer',
                        border: `1px solid ${isActive ? token.colorPrimary : token.colorBorderSecondary}`,
                        background: isActive ? token.colorPrimaryBg : token.colorBgContainer,
                        boxShadow: isActive ? `0 0 0 2px ${token.colorPrimaryBg}` : undefined,
                        borderRadius: 10,
                      }}
                      onClick={() => setActiveConfigId(item.id)}
                      styles={{ body: { padding: 16 } }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '8px' }}>
                        <div>
                          <Text strong style={{ fontSize: '15px' }}>{item.name || item.id}</Text>
                          <div><Text type="secondary" style={{ fontSize: '12px' }}>ID: {item.id}</Text></div>
                        </div>
                        {getStatusBadge(item.state)}
                      </div>

                      <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, margin: '8px 0' }} />

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Space>
                          {isRunning ? (
                            <Button
                              type="primary"
                              danger
                              size="small"
                              icon={<StopOutlined />}
                              onClick={(e) => { e.stopPropagation(); handleStopInstance(item.id); }}
                              loading={statusLoading[item.id]}
                            >
                              停止
                            </Button>
                          ) : (
                            <Button
                              type="primary"
                              size="small"
                              icon={<PlayCircleOutlined />}
                              onClick={(e) => { e.stopPropagation(); handleStartInstance(item.id); }}
                              loading={statusLoading[item.id]}
                              style={{ background: '#52c41a', borderColor: '#52c41a' }}
                            >
                              启动
                            </Button>
                          )}
                          {isRunning && (
                            <Button
                              size="small"
                              icon={<ReloadOutlined />}
                              onClick={(e) => { e.stopPropagation(); handleReloadInstance(item.id); }}
                              loading={statusLoading[item.id]}
                            />
                          )}
                        </Space>

                        <Space>
                          <Tooltip title="克隆配置">
                            <Button
                              size="small"
                              type="text"
                              icon={<CopyOutlined />}
                              onClick={(e) => { e.stopPropagation(); handleDuplicateConfig(item.id); }}
                            />
                          </Tooltip>
                          <Popconfirm
                            title="确定要删除这个配置文件吗？"
                            description="删除后相关代理设置将一并抹去且无法恢复。"
                            onConfirm={() => handleDeleteConfig(item.id)}
                            onPopupClick={(e) => e.stopPropagation()}
                            okText="确定"
                            cancelText="取消"
                          >
                            <Button
                              size="small"
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </Popconfirm>
                        </Space>
                      </div>
                    </Card>
                    </Dropdown>
                  );
                }}
              />
            )}
          </div>
        </Col>

        {/* 右栏：工作台面板 */}
        <Col xs={24} md={compactList ? 19 : 16}>
          {activeConfigId ? (
            <Card
              bordered={false}
              styles={{ body: { padding: 20 } }}
              style={{ height: '100%', minHeight: '520px', display: 'flex', flexDirection: 'column', borderRadius: 10 }}
            >
              <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>当前操作实例</Text>
                  <Title level={4} style={{ margin: '4px 0 0 0' }}>
                    {configs.find(c => c.id === activeConfigId)?.name || activeConfigId}
                  </Title>
                </div>
                <div>
                  {getStatusBadge(configs.find(c => c.id === activeConfigId)?.state)}
                </div>
              </div>

              <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                  {
                    key: 'proxies',
                    label: <Space><ThunderboltOutlined />代理穿透规则</Space>,
                    children: (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
                          <Text type="secondary">代理：把本地端口穿透到公网。访客：连接到对端 STCP/SUDP/XTCP 安全代理。</Text>
                          <Space size={8}>
                            <Button
                              type="primary"
                              icon={<ThunderboltOutlined />}
                              onClick={() => openProxyDrawer(undefined, 'proxy')}
                            >
                              新增代理
                            </Button>
                            <Dropdown
                              menu={{
                                items: [
                                  {
                                    key: 'add-visitor',
                                    icon: <ApiOutlined />,
                                    label: '添加访客 (Visitor)',
                                    onClick: () => openProxyDrawer(undefined, 'visitor'),
                                  },
                                ],
                              }}
                              placement="bottomRight"
                            >
                              <Button icon={<DownOutlined />} />
                            </Dropdown>
                          </Space>
                        </div>
                        <Table
                          dataSource={proxies}
                          loading={proxiesLoading}
                          rowKey="name"
                          size="small"
                          pagination={false}
                          style={{ background: 'transparent' }}
                          className="custom-table"
                          columns={[
                            {
                              title: '名称',
                              dataIndex: 'name',
                              render: (_, record) => (
                                <Space size={6}>
                                  {record._kind === 'visitor'
                                    ? <Tag color="purple" bordered={false}>访客</Tag>
                                    : <Tag color="geekblue" bordered={false}>代理</Tag>}
                                  <Text>{record.name}</Text>
                                </Space>
                              )
                            },
                            {
                              title: '类型',
                              dataIndex: 'type',
                              render: (type) => <Tag color={type === 'http' || type === 'https' ? 'blue' : 'orange'}>{type?.toUpperCase()}</Tag>
                            },
                            {
                              title: '本地 / 绑定',
                              render: (_, record) => {
                                if (record._kind === 'visitor') {
                                  return <Text type="secondary">{record.bindAddr || '127.0.0.1'}:{record.bindPort ?? '-'}</Text>;
                                }
                                return (
                                  <Text type="secondary">
                                    {record.local_ip || record.localIP || '-'}
                                    :
                                    {record.local_port || record.localPort || '-'}
                                  </Text>
                                );
                              }
                            },
                            {
                              title: '远端 / 服务名',
                              render: (_, record) => {
                                if (record._kind === 'visitor') {
                                  return <Text type="secondary">{record.serverName || '-'}{record.serverUser ? ` (用户: ${record.serverUser})` : ''}</Text>;
                                }
                                if (record.type === 'http' || record.type === 'https') {
                                  const domains = record.customDomains;
                                  return <Text type="secondary">{domains && domains.length ? domains.join(', ') : (record.subdomain ? `*.${record.subdomain}` : '—')}</Text>;
                                }
                                if (record.type === 'tcpmux') {
                                  const domains = record.customDomains;
                                  return <Text type="secondary">{domains && domains.length ? domains.join(', ') : (record.multiplexer || '—')}</Text>;
                                }
                                return <Text>{record.remotePort ?? '-'}</Text>;
                              }
                            },
                            {
                              title: '运行状态',
                              render: (_, record) => {
                                const phase = record.status;
                                if (record.disabled) return <Tag>已禁用</Tag>;
                                if (phase === 'running') return <Tag color="success">运行中</Tag>;
                                if (phase === 'new' || phase === 'start') return <Tag color="processing">启动中</Tag>;
                                if (phase === 'check failed' || phase === 'error') return <Tag color="error">{phase}</Tag>;
                                if (phase === 'closed') return <Tag>已关闭</Tag>;
                                return <Tag>—</Tag>;
                              }
                            },
                            {
                              title: '开关',
                              render: (_, record) => (
                                <Switch
                                  checked={!record.disabled}
                                  size="small"
                                  onChange={(checked) => handleToggleProxy(record.name, checked)}
                                />
                              )
                            },
                            {
                              title: '操作',
                              render: (_, record) => (
                                <Space>
                                  <Tooltip title="编辑">
                                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openProxyDrawer(record)} />
                                  </Tooltip>
                                  <Tooltip title="复制添加（沿用配置、自动生成新名称）">
                                    <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => openProxyDrawer(record, record._kind, true)} />
                                  </Tooltip>
                                  <Popconfirm
                                    title="确定删除此代理规则？"
                                    onConfirm={() => handleDeleteProxy(record.name)}
                                    okText="删除"
                                    cancelText="取消"
                                  >
                                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                                  </Popconfirm>
                                </Space>
                              )
                            }
                          ]}
                        />
                      </div>
                    )
                  },
                  {
                    key: 'visual',
                    label: <Space><EditOutlined />常规配置 (可视化)</Space>,
                    children: (
                      <Form
                        form={form}
                        layout="vertical"
                        onFinish={handleSaveVisualConfig}
                        style={{ maxWidth: '800px', marginTop: '12px' }}
                      >
                        <Tabs
                          type="line"
                          size="small"
                          tabBarStyle={{ marginBottom: 16, borderBottom: `1px solid ${token.colorBorderSecondary}` }}
                          items={[
                            {
                              key: 'basic',
                              label: '基本',
                              forceRender: true,
                              children: (
                                <div>
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item label={<span>实例备注名</span>} name="name">
                                        <Input placeholder="例如: 杭州云服务器" />
                                      </Form.Item>
                                    </Col>
                                    <Col span={12}>
                                      <Form.Item label={<span>用户名 (User)</span>} name="user">
                                        <Input placeholder="可作为代理名前缀标识，例如: hlj-win-221" />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Row gutter={16}>
                                    <Col span={16}>
                                      <Form.Item
                                        label={<span>FRP 服务端公网地址 (server_addr)</span>}
                                        name="serverAddr"
                                        rules={[{ required: true, message: '请输入 FRP 服务端地址' }]}
                                      >
                                        <Input placeholder="x.x.x.x 或 domain.com" />
                                      </Form.Item>
                                    </Col>
                                    <Col span={8}>
                                      <Form.Item
                                        label={<span>服务端端口 (server_port)</span>}
                                        name="serverPort"
                                        rules={[{ required: true, message: '必填' }]}
                                      >
                                        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item label={<span>随系统服务自动启动</span>} name="autoStart" valuePropName="checked" initialValue={true}>
                                        <Switch checkedChildren="随服务启动" unCheckedChildren="手动启动" />
                                      </Form.Item>
                                    </Col>
                                    <Col span={12}>
                                      <Form.Item label={<span>STUN 服务地址</span>} name="natHoleStunServer">
                                        <Input placeholder="用于 Nat 穿透，例如: stun.easyvoip.com:3478" />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                </div>
                              )
                            },
                            {
                              key: 'auth',
                              label: '认证',
                              forceRender: true,
                              children: (
                                <div>
                                  <Form.Item label={<span>认证方式</span>} name="authMethod">
                                    <Radio.Group buttonStyle="solid">
                                      <Radio.Button value="token">Token 认证</Radio.Button>
                                      <Radio.Button value="oidc">OIDC 认证</Radio.Button>
                                      <Radio.Button value="">无</Radio.Button>
                                    </Radio.Group>
                                  </Form.Item>

                                  <Form.Item
                                    noStyle
                                    shouldUpdate={(prevValues, currentValues) => prevValues.authMethod !== currentValues.authMethod}
                                  >
                                    {({ getFieldValue }) => {
                                      const authMethod = getFieldValue('authMethod');
                                      if (authMethod === 'token') {
                                        return (
                                          <Form.Item
                                            label={<span>Token 密钥 (auth.token)</span>}
                                            name="authToken"
                                            rules={[{ required: true, message: '请输入 Token 密钥' }]}
                                          >
                                            <RevealablePassword placeholder="FRP Server 对应的连接密钥" />
                                          </Form.Item>
                                        );
                                      }
                                      if (authMethod === 'oidc') {
                                        return (
                                          <div>
                                            <Row gutter={16}>
                                              <Col span={12}>
                                                <Form.Item label={<span>OIDC 客户端 ID</span>} name="oidcClientId">
                                                  <Input placeholder="clientId" />
                                                </Form.Item>
                                              </Col>
                                              <Col span={12}>
                                                <Form.Item label={<span>OIDC 客户端密钥</span>} name="oidcClientSecret">
                                                  <Input.Password placeholder="clientSecret" />
                                                </Form.Item>
                                              </Col>
                                            </Row>
                                            <Row gutter={16}>
                                              <Col span={12}>
                                                <Form.Item label={<span>受众 (Audience)</span>} name="oidcAudience">
                                                  <Input placeholder="audience" />
                                                </Form.Item>
                                              </Col>
                                              <Col span={12}>
                                                <Form.Item label={<span>作用域 (Scope)</span>} name="oidcScope">
                                                  <Input placeholder="scope" />
                                                </Form.Item>
                                              </Col>
                                            </Row>
                                            <Form.Item label={<span>Token 端点 URL</span>} name="oidcTokenEndpoint">
                                              <Input placeholder="https://oauth2.example.com/token" />
                                            </Form.Item>
                                          </div>
                                        );
                                      }
                                      return null;
                                    }}
                                  </Form.Item>
                                </div>
                              )
                            },
                            {
                              key: 'log',
                              label: '日志',
                              forceRender: true,
                              children: (
                                <Row gutter={16}>
                                  <Col span={12}>
                                    <Form.Item label={<span>日志级别 (log.level)</span>} name="logLevel">
                                      <Select>
                                        <Select.Option value="trace">trace (最详细)</Select.Option>
                                        <Select.Option value="debug">debug (调试)</Select.Option>
                                        <Select.Option value="info">info (常规信息)</Select.Option>
                                        <Select.Option value="warn">warn (警告)</Select.Option>
                                        <Select.Option value="error">error (错误)</Select.Option>
                                      </Select>
                                    </Form.Item>
                                  </Col>
                                  <Col span={12}>
                                    <Form.Item label={<span>日志保留天数 (log.max_days)</span>} name="logMaxDays">
                                      <InputNumber min={1} max={90} style={{ width: '100%' }} />
                                    </Form.Item>
                                  </Col>
                                </Row>
                              )
                            },
                            {
                              key: 'admin',
                              label: '管理',
                              forceRender: true,
                              children: (
                                <div>
                                  <Row gutter={16}>
                                    <Col span={16}>
                                      <Form.Item label={<span>管理 HTTP 监听地址 (webServer.addr)</span>} name="adminAddr">
                                        <Input placeholder="127.0.0.1" />
                                      </Form.Item>
                                    </Col>
                                    <Col span={8}>
                                      <Form.Item label={<span>管理端口</span>} name="adminPort">
                                        <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="7400" />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item label={<span>管理用户名</span>} name="adminUser">
                                        <Input placeholder="admin" />
                                      </Form.Item>
                                    </Col>
                                    <Col span={12}>
                                      <Form.Item label={<span>管理密码</span>} name="adminPwd">
                                        <Input.Password placeholder="admin" />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Row gutter={16}>
                                    <Col span={16}>
                                      <Form.Item label={<span>管理后台静态资源目录</span>} name="assetsDir">
                                        <Input placeholder="填入本地静态网页路径可托管仪表盘" />
                                      </Form.Item>
                                    </Col>
                                    <Col span={8}>
                                      <Form.Item label={<span>Pprof 调试服务</span>} name="pprofEnable" valuePropName="checked">
                                        <Switch checkedChildren="已开启" unCheckedChildren="关闭" />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                </div>
                              )
                            },
                            {
                              key: 'transport',
                              label: '连接/TLS',
                              forceRender: true,
                              children: (
                                <div>
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item label={<span>传输层协议 (transport.protocol)</span>} name="protocol">
                                        <Select>
                                          <Select.Option value="tcp">TCP 协议 (默认)</Select.Option>
                                          <Select.Option value="kcp">KCP 协议 (UDP加速)</Select.Option>
                                          <Select.Option value="quic">QUIC 协议</Select.Option>
                                          <Select.Option value="websocket">Websocket 协议</Select.Option>
                                          <Select.Option value="wss">WSS 安全网页套接字</Select.Option>
                                        </Select>
                                      </Form.Item>
                                    </Col>
                                    <Col span={12}>
                                      <Form.Item label={<span>连接超时时间 (秒)</span>} name="dialServerTimeout">
                                        <InputNumber min={1} style={{ width: '100%' }} />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item label={<span>保活心跳间隔 (秒)</span>} name="heartbeatInterval">
                                        <InputNumber min={1} style={{ width: '100%' }} />
                                      </Form.Item>
                                    </Col>
                                    <Col span={12}>
                                      <Form.Item label={<span>心跳超时阈值 (秒)</span>} name="heartbeatTimeout">
                                        <InputNumber min={1} style={{ width: '100%' }} />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item label={<span>连接池初始数量 (pool_count)</span>} name="poolCount">
                                        <InputNumber min={0} max={100} style={{ width: '100%' }} />
                                      </Form.Item>
                                    </Col>
                                    <Col span={12}>
                                      <Form.Item label={<span>多路复用 (TCP Mux)</span>} name="tcpMux" valuePropName="checked">
                                        <Switch checkedChildren="已启用" unCheckedChildren="禁用" />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item
                                        label={<span>登录失败行为 (loginFailExit)</span>}
                                        name="loginFailExit"
                                        valuePropName="checked"
                                        initialValue={false}
                                        tooltip="开：首次连接服务端失败直接退出。关：失败后无限重试，适合服务端偶尔重启的场景。默认关（持续重试）。"
                                      >
                                        <Switch checkedChildren="失败即退出" unCheckedChildren="持续重试" />
                                      </Form.Item>
                                    </Col>
                                  </Row>

                                  <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, margin: '16px 0 12px 0', paddingTop: 12 }}>
                                    <Text strong style={{ fontSize: 13 }}>FRP TLS 安全通讯</Text>
                                  </div>

                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item label={<span>强制启用 TLS 传输加密</span>} name="tlsEnable" valuePropName="checked">
                                        <Switch checkedChildren="已开启" unCheckedChildren="未启用" />
                                      </Form.Item>
                                    </Col>
                                    <Col span={12}>
                                      <Form.Item label={<span>禁用 TLS 首字节校验</span>} name="disableCustomTLSFirstByte" valuePropName="checked">
                                        <Switch checkedChildren="已禁用" unCheckedChildren="校验首字节" />
                                      </Form.Item>
                                    </Col>
                                  </Row>

                                  <Form.Item
                                    noStyle
                                    shouldUpdate={(prevValues, currentValues) => prevValues.tlsEnable !== currentValues.tlsEnable}
                                  >
                                    {({ getFieldValue }) => {
                                      if (getFieldValue('tlsEnable')) {
                                        return (
                                          <div>
                                            <Row gutter={16}>
                                              <Col span={12}>
                                                <Form.Item label={<span>客户端证书文件路径</span>} name="tlsCertFile">
                                                  <Input placeholder="C:\certs\client.crt" />
                                                </Form.Item>
                                              </Col>
                                              <Col span={12}>
                                                <Form.Item label={<span>客户端私钥文件路径</span>} name="tlsKeyFile">
                                                  <Input placeholder="C:\certs\client.key" />
                                                </Form.Item>
                                              </Col>
                                            </Row>
                                            <Row gutter={16}>
                                              <Col span={12}>
                                                <Form.Item label={<span>受信任 CA 证书</span>} name="tlsTrustedCaFile">
                                                  <Input placeholder="C:\certs\ca.crt" />
                                                </Form.Item>
                                              </Col>
                                              <Col span={12}>
                                                <Form.Item label={<span>TLS 校验域名 (ServerName)</span>} name="tlsServerName">
                                                  <Input placeholder="frp.yourdomain.com" />
                                                </Form.Item>
                                              </Col>
                                            </Row>
                                          </div>
                                        );
                                      }
                                      return null;
                                    }}
                                  </Form.Item>
                                </div>
                              )
                            }
                          ]}
                        />

                        <Form.Item style={{ marginTop: 20, borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 16, textAlign: 'right' }}>
                          <Button type="primary" htmlType="submit">保存全部客户端配置</Button>
                        </Form.Item>
                      </Form>
                    )
                  },
                  {
                    key: 'toml',
                    label: <Space><CodeOutlined />高级 TOML 配置</Space>,
                    children: (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', gap: 12, flexWrap: 'wrap' }}>
                          <Space size={8}>
                            <Tag color="cyan" bordered={false}>TOML</Tag>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              CodeMirror 编辑器 · 语法高亮 · Ctrl+F 搜索 · 保存时自动调用 /validate
                            </Text>
                          </Space>
                          <Space>
                            <Tooltip title="刷新读取磁盘上的 TOML">
                              <Button
                                size="small"
                                icon={<ReloadOutlined />}
                                onClick={() => loadRawToml(activeConfigId)}
                                loading={tomlLoading}
                              />
                            </Tooltip>
                            <Button
                              type="primary"
                              icon={<CheckCircleOutlined />}
                              onClick={handleSaveRawToml}
                              loading={tomlLoading}
                              style={{ background: '#52c41a', borderColor: '#52c41a' }}
                            >
                              校验并保存
                            </Button>
                          </Space>
                        </div>
                        <div
                          style={{
                            border: `1px solid ${themeMode === 'dark' ? token.colorBorderSecondary : '#1f2933'}`,
                            borderRadius: 8,
                            overflow: 'hidden',
                            background: '#0b0f14',
                            boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.5)',
                          }}
                        >
                          <CodeMirror
                            value={rawToml}
                            onChange={(v) => setRawToml(v)}
                            // TOML 编辑器始终用暗色系（oneDark），与整体 antd 主题脱钩 —
                            // 让代码块拥有传统 IDE 那种"专注的深色编辑面板"视觉，浅色主题下也不刺眼
                            theme={oneDark}
                            extensions={tomlExtensions}
                            height="calc(100vh - 320px)"
                            minHeight="420px"
                            maxHeight="78vh"
                            basicSetup={{
                              lineNumbers: true,
                              foldGutter: true,
                              highlightActiveLine: true,
                              highlightActiveLineGutter: true,
                              bracketMatching: true,
                              closeBrackets: true,
                              autocompletion: false,
                              tabSize: 2,
                              searchKeymap: true,
                            }}
                            style={{ fontSize: 13 }}
                          />
                        </div>
                      </div>
                    )
                  },
                  {
                    key: 'logs',
                    label: <Space><FileTextOutlined />运行日志速览</Space>,
                    children: (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', gap: 12, flexWrap: 'wrap' }}>
                          <Space size={10}>
                            <Badge
                              status={
                                miniLogsWsState === 'connected' ? 'success'
                                : miniLogsWsState === 'connecting' ? 'processing'
                                : 'default'
                              }
                              text={
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {miniLogsWsState === 'connected' ? '实时流接通'
                                    : miniLogsWsState === 'connecting' ? '正在连接…'
                                    : '已断开'} · 最近 {MINI_LOGS_MAX} 行
                                </Text>
                              }
                            />
                          </Space>
                          <Space>
                            <Switch
                              size="small"
                              checked={miniLogsPaused}
                              onChange={setMiniLogsPaused}
                              checkedChildren="已暂停"
                              unCheckedChildren="实时滚动"
                            />
                            <Button
                              size="small"
                              icon={<DeleteOutlined />}
                              onClick={() => handleClearMiniLogs(activeConfigId)}
                            >
                              清空
                            </Button>
                            <Button
                              size="small"
                              icon={<ReloadOutlined />}
                              onClick={() => loadMiniLogs(activeConfigId)}
                            >
                              重连
                            </Button>
                          </Space>
                        </div>
                        {miniLogsLoading && miniLogLines.length === 0 ? (
                          <Skeleton active />
                        ) : (
                          <div
                            className="terminal-container"
                            style={{
                              // 与「高级 TOML 配置」编辑器同款响应式高度，保持视觉一致
                              height: 'calc(100vh - 320px)',
                              minHeight: 420,
                              maxHeight: '78vh',
                              margin: 0,
                              overflowY: 'auto',
                              position: 'relative',
                            }}
                          >
                            {miniLogLines.length === 0 ? (
                              <div style={{ opacity: 0.5, padding: 16, textAlign: 'center' }}>
                                暂无日志，等待 frpc 输出…
                              </div>
                            ) : (
                              <>
                                {miniLogLines.map((line, idx) => (
                                  <div key={idx} className={miniLogClass(line)}>{line}</div>
                                ))}
                                <div ref={miniLogsBottomRef} />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  }
                ]}
              />
            </Card>
          ) : (
            <Card style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '100px 0', borderRadius: 10 }}>
              <Empty description="请在左侧选择或创建一个配置文件。" />
            </Card>
          )}
        </Col>
      </Row>

      {/* 新建配置 Modal */}
      <Modal
        title="新建配置文件"
        open={newConfigModalOpen}
        onCancel={() => setNewConfigModalOpen(false)}
        maskClosable={false}
        footer={null}
        destroyOnClose
      >
        <Form form={newConfigForm} layout="vertical" onFinish={handleCreateConfig}>
          <Form.Item
            label="唯一ID标识 (必须为纯英文/数字/下划线)"
            name="id"
            rules={[
              { required: true, message: '请输入配置ID' },
              { pattern: /^[a-zA-Z0-9_-]+$/, message: '仅支持英文字母、数字、下划线及中划线' }
            ]}
          >
            <Input placeholder="例如: web_proxy" />
          </Form.Item>
          <Form.Item label="显示名称备注" name="name">
            <Input placeholder="例如: 公司内网测试" />
          </Form.Item>
          <Form.Item label="节点用户名 (User)" name="user" tooltip="frpc 的 user 前缀，用于在服务端区分不同节点，可空">
            <Input placeholder="例如: dt-116-node" />
          </Form.Item>
          <Form.Item label="FRP 服务端地址" name="serverAddr" initialValue="127.0.0.1">
            <Input placeholder="例如: 8.8.8.8" />
          </Form.Item>
          <Form.Item label="服务端端口" name="serverPort" initialValue={7000}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="密钥 Token" name="token">
            <Input.Password placeholder="可空" />
          </Form.Item>
          <Form.Item label="随系统服务自动启动" name="autoStart" valuePropName="checked" initialValue={true}>
            <Switch checkedChildren="随服务启动" unCheckedChildren="手动启动" />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Space>
              <Button onClick={() => setNewConfigModalOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit">创建</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* 新建/编辑 代理 / 访客 Drawer */}
      <Drawer
        title={editingProxy
          ? `编辑${editingProxy._kind === 'visitor' ? '访客' : '代理'}规则`
          : '添加规则'}
        width={640}
        maskClosable={false}
        onClose={() => setProxyDrawerOpen(false)}
        open={proxyDrawerOpen}
        styles={{ body: { paddingBottom: 80 } }}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setProxyDrawerOpen(false)}>取消</Button>
              <Button onClick={() => proxyForm.submit()} type="primary">提交保存</Button>
            </Space>
          </div>
        }
      >
        <Form form={proxyForm} layout="vertical" onFinish={handleSaveProxy}>
          {/* 资源类型：代理 (服务端) / 访客 (visitor) */}
          <Form.Item label="资源类型" name="kind" initialValue="proxy" tooltip="代理：把本地端口暴露到公网。访客：连接到对端 STCP/SUDP/XTCP 安全代理。">
            <Radio.Group
              buttonStyle="solid"
              disabled={!!editingProxy}
              onChange={(e) => {
                // 切换到 visitor 时，把类型自动落到 stcp（如果当前类型不在白名单内）
                if (e.target.value === 'visitor') {
                  const cur = proxyForm.getFieldValue('type');
                  if (cur !== 'stcp' && cur !== 'sudp' && cur !== 'xtcp') {
                    proxyForm.setFieldsValue({ type: 'stcp' });
                  }
                }
              }}
            >
              <Radio.Button value="proxy">代理 (服务端)</Radio.Button>
              <Radio.Button value="visitor">访客 (Visitor)</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <Form.Item
            label="规则名称 (唯一)"
            name="name"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input
              placeholder={proxyForm.getFieldValue('kind') === 'visitor' ? 'speed-test-visitor' : 'ssh'}
              disabled={!!editingProxy}
              addonAfter={editingProxy ? undefined : (
                <Tooltip title="随机生成专业规则名">
                  <a onClick={() => proxyForm.setFieldsValue({ name: genRuleName() })}>
                    <ThunderboltOutlined /> 随机
                  </a>
                </Tooltip>
              )}
            />
          </Form.Item>

          {/* 类型下拉：随 kind 限制选项 */}
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.kind !== cur.kind}
          >
            {({ getFieldValue }) => {
              const kind = getFieldValue('kind') || 'proxy';
              const fullOpts = [
                { value: 'tcp', label: 'TCP — 通用端口转发' },
                { value: 'udp', label: 'UDP — 通用 UDP 转发' },
                { value: 'http', label: 'HTTP — 网站/API' },
                { value: 'https', label: 'HTTPS — 直通 TLS' },
                { value: 'tcpmux', label: 'TCPMUX — 端口复用 (httpconnect)' },
                { value: 'stcp', label: 'STCP — 安全 P2P (需共享密钥)' },
                { value: 'sudp', label: 'SUDP — 安全 P2P UDP' },
                { value: 'xtcp', label: 'XTCP — NAT 穿透 P2P' },
              ];
              const visitorOpts = fullOpts.filter((o) => ['stcp', 'sudp', 'xtcp'].includes(o.value));
              return (
                <Form.Item label="穿透协议类型" name="type" rules={[{ required: true }]} initialValue="tcp">
                  <Select options={kind === 'visitor' ? visitorOpts : fullOpts} />
                </Form.Item>
              );
            }}
          </Form.Item>

          {/* ===== Visitor 模式表单区块 ===== */}
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.kind !== cur.kind || prev.type !== cur.type}
          >
            {({ getFieldValue }) => {
              if (getFieldValue('kind') !== 'visitor') return null;
              const type = getFieldValue('type');
              return (
                <>
                  <Form.Item
                    label="共享密钥 secretKey"
                    name="secretKey"
                    rules={[{ required: true, message: '访客必须填写与服务端一致的共享密钥' }]}
                  >
                    <Input placeholder="与对端服务端代理相同的 secretKey" />
                  </Form.Item>
                  <Row gutter={12}>
                    <Col span={14}>
                      <Form.Item
                        label="服务名 serverName"
                        name="serverName"
                        rules={[{ required: true, message: '请输入对端 STCP/SUDP/XTCP 代理的 name' }]}
                      >
                        <Input placeholder="speed-test-tcp" />
                      </Form.Item>
                    </Col>
                    <Col span={10}>
                      <Form.Item label="服务用户 serverUser" name="serverUser" tooltip="对端 frpc 的 user 前缀，未配置可空">
                        <Input placeholder="ln2-node" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={12}>
                    <Col span={14}>
                      <Form.Item label="本地绑定地址 bindAddr" name="bindAddr" initialValue="127.0.0.1">
                        <Input placeholder="127.0.0.1" />
                      </Form.Item>
                    </Col>
                    <Col span={10}>
                      <Form.Item
                        label="本地绑定端口 bindPort"
                        name="bindPort"
                        rules={[{ required: true, message: '请输入访客监听端口' }]}
                      >
                        <InputNumber min={-1} max={65535} style={{ width: '100%' }} placeholder="12081" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item label="加密传输" name="useEncryption" valuePropName="checked">
                        <Switch checkedChildren="启用" unCheckedChildren="关闭" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item label="压缩传输" name="useCompression" valuePropName="checked">
                        <Switch checkedChildren="启用" unCheckedChildren="关闭" />
                      </Form.Item>
                    </Col>
                  </Row>

                  {type === 'xtcp' && (
                    <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 12, marginTop: 4 }}>
                      <Text strong style={{ fontSize: 13 }}>XTCP 访客高级参数</Text>
                      <Row gutter={12} style={{ marginTop: 8 }}>
                        <Col span={12}>
                          <Form.Item label="P2P 协议 protocol" name="xtcpProtocol" initialValue="quic">
                            <Select options={[{ value: 'quic', label: 'QUIC (默认)' }, { value: 'kcp', label: 'KCP' }]} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item label="保持隧道常开" name="keepTunnelOpen" valuePropName="checked">
                            <Switch checkedChildren="开" unCheckedChildren="关" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={12}>
                        <Col span={12}>
                          <Form.Item label="每小时最大重试 maxRetriesAnHour" name="maxRetriesAnHour">
                            <InputNumber min={0} max={100} style={{ width: '100%' }} placeholder="8" />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item label="最小重试间隔 (秒)" name="minRetryInterval">
                            <InputNumber min={0} style={{ width: '100%' }} placeholder="90" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={12}>
                        <Col span={14}>
                          <Form.Item label="回退到 (fallbackTo)" name="fallbackTo" tooltip="P2P 失败时切换到这个访客名">
                            <Input placeholder="另一个 visitor 的 name" />
                          </Form.Item>
                        </Col>
                        <Col span={10}>
                          <Form.Item label="回退超时 (ms)" name="fallbackTimeoutMs">
                            <InputNumber min={0} style={{ width: '100%' }} placeholder="1000" />
                          </Form.Item>
                        </Col>
                      </Row>
                    </div>
                  )}
                </>
              );
            }}
          </Form.Item>

          {/* ===== Proxy 模式表单区块 ===== */}
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.kind !== cur.kind || prev.type !== cur.type || prev.pluginName !== cur.pluginName}
          >
            {({ getFieldValue }) => {
              if (getFieldValue('kind') === 'visitor') return null;
              const usingPlugin = !!getFieldValue('pluginName');
              return (
                <>
                  <Form.Item label="本地监听 IP" name="localIP" initialValue="127.0.0.1">
                    <Input placeholder="127.0.0.1" disabled={usingPlugin} />
                  </Form.Item>
                  <Form.Item
                    label="本地映射端口"
                    name="localPort"
                    rules={usingPlugin ? [] : [{ required: true, message: '请输入本地端口' }]}
                  >
                    <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="22" disabled={usingPlugin} />
                  </Form.Item>
                </>
              );
            }}
          </Form.Item>

          {/* Proxy 类型相关字段 */}
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.kind !== cur.kind || prev.type !== cur.type}
          >
            {({ getFieldValue }) => {
              if (getFieldValue('kind') === 'visitor') return null;
              const type = getFieldValue('type');
              if (type === 'http' || type === 'https') {
                return (
                  <>
                    <Form.Item
                      label="自定义域名 customDomains (逗号分隔)"
                      name="customDomains"
                      tooltip="HTTP/HTTPS 至少指定 customDomains 或 subdomain 其一"
                    >
                      <Input placeholder="app.example.com" />
                    </Form.Item>
                    <Form.Item label="子域名 subdomain" name="subdomain">
                      <Input placeholder="myapp" />
                    </Form.Item>
                    {type === 'http' && (
                      <>
                        <Form.Item label="路径前缀 locations (逗号分隔)" name="locations">
                          <Input placeholder="/api,/static" />
                        </Form.Item>
                        <Form.Item label="HostHeaderRewrite" name="hostHeaderRewrite">
                          <Input placeholder="internal.example.com" />
                        </Form.Item>
                        <Form.Item label="HTTP 用户名" name="httpUser">
                          <Input placeholder="为 Basic Auth 添加用户名" />
                        </Form.Item>
                        <Form.Item label="HTTP 密码" name="httpPassword">
                          <Input.Password placeholder="为 Basic Auth 添加密码" />
                        </Form.Item>
                      </>
                    )}
                  </>
                );
              }
              if (type === 'tcpmux') {
                return (
                  <>
                    <Form.Item label="复用器 multiplexer" name="multiplexer" initialValue="httpconnect">
                      <Select options={[{ value: 'httpconnect', label: 'httpconnect (默认)' }]} />
                    </Form.Item>
                    <Form.Item label="自定义域名 customDomains (逗号分隔)" name="customDomains" rules={[{ required: true }]}>
                      <Input placeholder="proxy.example.com" />
                    </Form.Item>
                    <Form.Item label="路由 HTTP 用户名 routeByHTTPUser" name="routeByHTTPUser">
                      <Input placeholder="可选：按 Basic 用户名路由" />
                    </Form.Item>
                  </>
                );
              }
              if (type === 'stcp' || type === 'sudp' || type === 'xtcp') {
                return (
                  <>
                    <Form.Item label="共享密钥 secretKey" name="secretKey" rules={[{ required: true, message: '安全代理必须设置 secretKey' }]}>
                      <Input placeholder="访客端与服务端共享密钥" />
                    </Form.Item>
                    <Form.Item label="允许访问的用户 allowUsers (逗号分隔，可选)" name="allowUsers">
                      <Input placeholder="alice,bob 或 *" />
                    </Form.Item>
                  </>
                );
              }
              // tcp / udp
              return (
                <Form.Item
                  label="公网暴露端口 remotePort"
                  name="remotePort"
                  rules={[{ required: true, message: '请输入公网暴露端口' }]}
                >
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="6000" />
                </Form.Item>
              );
            }}
          </Form.Item>

          {/* 插件透传（高级，仅代理可用） */}
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.kind !== cur.kind || prev.pluginName !== cur.pluginName}
          >
            {({ getFieldValue }) => {
              if (getFieldValue('kind') === 'visitor') return null;
              const p = getFieldValue('pluginName');
              const needsLocalAddr = !!p && ['http2http', 'http2https', 'https2http', 'https2https', 'tls2raw'].includes(p);
              const needsLocalPath = p === 'static_file' || p === 'unix_domain_socket';
              const needsAuth = p === 'http_proxy' || p === 'socks5' || p === 'static_file';
              return (
                <>
                  <Form.Item
                    label="高级：使用本地插件代替 local 端口"
                    name="pluginName"
                    tooltip="选择后将由 frpc 内置插件提供后端服务，可不填本地 IP/端口"
                  >
                    <Select
                      allowClear
                      placeholder="可选：选择插件以替代 local 端口"
                      options={[
                        { value: 'http_proxy', label: 'http_proxy — HTTP 代理' },
                        { value: 'socks5', label: 'socks5 — SOCKS5 代理' },
                        { value: 'static_file', label: 'static_file — 静态文件服务' },
                        { value: 'unix_domain_socket', label: 'unix_domain_socket' },
                        { value: 'http2http', label: 'http2http' },
                        { value: 'http2https', label: 'http2https' },
                        { value: 'https2http', label: 'https2http' },
                        { value: 'https2https', label: 'https2https' },
                        { value: 'tls2raw', label: 'tls2raw' },
                      ]}
                    />
                  </Form.Item>
                  {needsLocalAddr && (
                    <Form.Item label="插件 localAddr" name="pluginLocalAddr" rules={[{ required: true }]}>
                      <Input placeholder="127.0.0.1:8080" />
                    </Form.Item>
                  )}
                  {needsLocalPath && (
                    <Form.Item label={p === 'static_file' ? '静态目录 localPath' : 'Socket 路径 localPath'} name="pluginLocalPath" rules={[{ required: true }]}>
                      <Input placeholder={p === 'static_file' ? '/var/www' : '/var/run/app.sock'} />
                    </Form.Item>
                  )}
                  {needsAuth && (
                    <>
                      <Form.Item label="插件用户名" name="pluginHTTPUser">
                        <Input placeholder="可选" />
                      </Form.Item>
                      <Form.Item label="插件密码" name="pluginHTTPPassword">
                        <Input.Password placeholder="可选" />
                      </Form.Item>
                    </>
                  )}
                </>
              );
            }}
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};

export default Configs;
