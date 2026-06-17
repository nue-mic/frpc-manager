import { useEffect, useState, useRef } from 'react';
import type { ComponentProps, DragEvent, CSSProperties } from 'react';
import {
  Card, Row, Col, Button, Badge, Space, Typography, Popconfirm,
  Tabs, Form, Input, InputNumber, Switch, Table, Drawer, Modal,
  message, Tag, Tooltip, Empty, List, Skeleton, Radio, Select, Dropdown,
  Alert,
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
  HolderOutlined,
  SwapOutlined,
  UserOutlined,
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
import { stripLogNoise } from '../utils/log';
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

  // 代理列表：多选 + 拖拽排序 + 批量迁移
  const [selectedProxyKeys, setSelectedProxyKeys] = useState<string[]>([]);
  const [migrateModalOpen, setMigrateModalOpen] = useState<boolean>(false);
  const [migrateTargetId, setMigrateTargetId] = useState<string>('');
  const [migrating, setMigrating] = useState<boolean>(false);
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // 左栏 FRPS 实例列表拖拽排序
  const configDragIndexRef = useRef<number | null>(null);
  const [configDragOverIndex, setConfigDragOverIndex] = useState<number | null>(null);

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

  // 切换实例时清空多选与迁移态，避免把 A 实例的勾选/迁移目标带到 B
  useEffect(() => {
    setSelectedProxyKeys([]);
    setMigrateModalOpen(false);
    setMigrateTargetId('');
  }, [activeConfigId]);

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

  // 左栏 FRPS 实例拖拽排序：仅手柄触发；乐观更新本地顺序，再把完整 id 顺序
  // 持久化到 meta.sort（POST /configs/reorder）；失败回滚重拉。
  const handleConfigReorder = async (dropIndex: number) => {
    const from = configDragIndexRef.current;
    configDragIndexRef.current = null;
    setConfigDragOverIndex(null);
    if (from === null || from === dropIndex) return;
    const next = [...configs];
    const [moved] = next.splice(from, 1);
    next.splice(dropIndex, 0, moved);
    setConfigs(next);
    try {
      await client.post('/api/v1/configs/reorder', { order: next.map((c) => c.id) });
    } catch {
      message.error('实例排序保存失败，已回滚');
      fetchConfigs();
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
      // 顺手缓存完整实例配置：规则抽屉里的 vnet 提示要据此显示本机虚拟地址
      // （/proxies tab 不会触发 loadVisualConfig，否则 detailConfig 会是空/过期）。
      setDetailConfig(envResp.data);
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
      // 选区对账：剔除已不在最新列表中的幽灵 key（外部/异步刷新把选中规则删除/
      // 迁移/改名后残留），避免批量工具条计数偏大或把不存在的名字发给后端而失败。
      setSelectedProxyKeys((prev) => prev.filter((k) => merged.some((p) => p.name === k)));
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

  // 拖拽排序：仅当从行首手柄发起（dragIndexRef 已被 onDragStart 置位）才生效，
  // 其他区域不触发，避免误操作。先乐观更新本地顺序，再把完整顺序持久化到后端
  // （后端一次 Update→一次热重载）；失败回滚重载。
  const handleProxyDrop = async (dropIndex: number) => {
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    setDragOverIndex(null);
    if (from === null || from === dropIndex) return;
    const next = [...proxies];
    const [moved] = next.splice(from, 1);
    next.splice(dropIndex, 0, moved);
    setProxies(next);
    try {
      await client.post(`/api/v1/configs/${activeConfigId}/proxies/reorder`, {
        order: next.map((p) => p.name),
      });
    } catch {
      message.error('排序保存失败，已回滚');
      loadProxies(activeConfigId);
    }
  };

  // 批量删除选中的代理 / 访客（一次请求，后端原子删除 + 单次热重载）
  const handleBatchDelete = async () => {
    if (selectedProxyKeys.length === 0) return;
    try {
      const resp = await client.post(`/api/v1/configs/${activeConfigId}/proxies/batch-delete`, {
        names: selectedProxyKeys,
      });
      message.success(`已删除 ${resp.data?.deleted ?? selectedProxyKeys.length} 条规则`);
      setSelectedProxyKeys([]);
      loadProxies(activeConfigId);
    } catch {
      message.error('批量删除失败');
    }
  };

  // 批量迁移选中规则到另一个 FRPS 实例（后端原子搬移：先加目标、后删来源）
  const handleMigrate = async () => {
    if (!migrateTargetId || selectedProxyKeys.length === 0) return;
    setMigrating(true);
    try {
      const resp = await client.post(`/api/v1/configs/${activeConfigId}/proxies/move`, {
        target_id: migrateTargetId,
        names: selectedProxyKeys,
      });
      message.success(`已迁移 ${resp.data?.moved ?? selectedProxyKeys.length} 条规则`);
      setMigrateModalOpen(false);
      setMigrateTargetId('');
      setSelectedProxyKeys([]);
      loadProxies(activeConfigId);
    } catch (err: any) {
      const status = err?.response?.status;
      const code = err?.response?.data?.error?.code;
      const details = err?.response?.data?.error?.details;
      if (code === 'proxy_already_exists' && Array.isArray(details?.names)) {
        message.error(`目标实例已存在同名规则：${details.names.join('、')}`);
      } else if (status === 500 && details?.moved) {
        // 半完成：目标已写入但来源未删除。提示用户去目标核对、删当前实例的重复，
        // 并收尾本侧 UI（刷新会通过选区对账剔除已迁走的行）。
        message.warning('已写入目标实例，但未能从当前实例移除，请到目标实例核对并删除当前实例的重复规则');
        setMigrateModalOpen(false);
        setMigrateTargetId('');
        setSelectedProxyKeys([]);
        loadProxies(activeConfigId);
      } else {
        message.error('迁移失败');
      }
    } finally {
      setMigrating(false);
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
          // 组网 (VNet)
          virtualNetEnabled: !!(configData.featureGates?.VirtualNet),
          virtualNetAddress: configData.virtualNet?.address || '',
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
        setMiniLogLines(lines.slice(-MINI_LOGS_MAX).map(stripLogNoise));
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
          next.push(stripLogNoise(line!));
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
          // 组网 (VNet)：开启时写 featureGates.VirtualNet + virtualNet.address；
          // 关闭时置 undefined（JSON 序列化会省略该 key，等于清除）。
          featureGates: values.virtualNetEnabled
            ? { ...(detailConfig?.config?.featureGates ?? {}), VirtualNet: true }
            : undefined,
          virtualNet: values.virtualNetEnabled
            ? { address: values.virtualNetAddress || undefined }
            : undefined,
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
          // 新建即预填一套兼容 Cloudflare 代理（约 100s 空闲超时）的稳健连接默认值：
          // 心跳间隔取 20s（远小于 CF 空闲超时，主动保活防断），其余沿用 frp 推荐值。
          transport: {
            dialServerTimeout: 10,
            heartbeatInterval: 20,
            heartbeatTimeout: 90,
            poolCount: 5,
          },
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
          // 新建默认 0.0.0.0(表单已填); 编辑既有规则若用户清空则省略, 交 frp 兜底
          // (空→127.0.0.1), 避免把历史空值静默改成全网卡监听。
          bindAddr: values.bindAddr || undefined,
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
        // 组网网关 (vnet) 访客插件：携带 destinationIP（对端虚拟 IP）。
        // 字段名严格 camelCase（destinationIP），与上游 frp 一致。
        if (values.visitorPlugin) {
          const plugin: Record<string, unknown> = { type: values.visitorPlugin };
          if (values.destinationIP) plugin.destinationIP = values.destinationIP;
          v.plugin = plugin;
        }
        body = { visitor: v };
      } else {
        const payload: Record<string, unknown> = {
          name: values.name,
          type: t,
          // 同上: 新建默认 0.0.0.0; 编辑清空则省略, 交 frp 兜底, 不静默改写。
          localIP: values.localIP || undefined,
          localPort: values.localPort,
        };
        // 传输层加密 / 压缩（与 visitor 对称）。frp 中 proxy 与 visitor 两端各自
        // 按自身 transport.useEncryption/useCompression 包装，且不协商：STCP/XTCP/SUDP
        // 必须两端完全一致，否则隧道能建立但数据为乱码、无法访问。仅当用户实际切过
        // 开关(非 undefined)才下发，保持新建时的干净 payload。
        if (values.useEncryption !== undefined || values.useCompression !== undefined) {
          payload.transport = {
            useEncryption: !!values.useEncryption,
            useCompression: !!values.useCompression,
          };
        }
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
        // 插件透传：字段名必须按 plugin.type 分发到上游 frp v1 的正确 key
        // （pkg/config/v1/proxy_plugin.go）。写错不会 400（TypedClientPluginOptions
        // 自定义 UnmarshalJSON 走非严格解码）而是被静默丢弃——socks5 会变成无鉴权、
        // unix_domain_socket 会丢失路径。所以同一组输入框要按类型映射到不同 key：
        //   socks5             → username / password   （非 httpUser/httpPassword）
        //   unix_domain_socket → unixPath               （非 localPath）
        //   http_proxy/static_file → httpUser/httpPassword
        if (values.pluginName) {
          const pname = values.pluginName as string;
          const plugin: Record<string, unknown> = { type: pname };
          if (values.pluginLocalAddr) plugin.localAddr = values.pluginLocalAddr;
          if (values.pluginLocalPath) {
            if (pname === 'unix_domain_socket') plugin.unixPath = values.pluginLocalPath;
            else plugin.localPath = values.pluginLocalPath;
          }
          if (values.pluginHTTPUser) {
            if (pname === 'socks5') plugin.username = values.pluginHTTPUser;
            else plugin.httpUser = values.pluginHTTPUser;
          }
          if (values.pluginHTTPPassword) {
            if (pname === 'socks5') plugin.password = values.pluginHTTPPassword;
            else plugin.httpPassword = values.pluginHTTPPassword;
          }
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

  // 生成一个专业、强随机的共享密钥（crypto 强随机）：
  // - 去掉易混字符（大写无 I O、小写无 l o、数字无 0 1）；
  // - 首尾只用「大写或数字」（不以小写字母开头/结尾）；中间用全字符集；
  // - 默认 32 位，观感接近大厂 API key / 强密钥。
  const genSecretKey = (len = 32): string => {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digit = '23456789';
    const edge = upper + digit;      // 首尾候选
    const all = upper + lower + digit;
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    let out = '';
    for (let i = 0; i < len; i++) {
      const pool = (i === 0 || i === len - 1) ? edge : all;
      out += pool[buf[i] % pool.length];
    }
    return out;
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
        localIP: proxyItem.localIP || '',
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
        // 回填：与保存侧对称，按 plugin.type 从正确的 v1 key 读回到统一输入框。
        // record.plugin 来自 GET /configs/{id} 的 camelCase 完整定义（见 loadProxies
        // 的 merge），含 username/password/unixPath，可直接回读。
        pluginName: pl.type,
        pluginLocalAddr: pl.localAddr,
        pluginLocalPath: pl.type === 'unix_domain_socket' ? pl.unixPath : pl.localPath,
        pluginHTTPUser: pl.type === 'socks5' ? pl.username : pl.httpUser,
        pluginHTTPPassword: pl.type === 'socks5' ? pl.password : pl.httpPassword,
        // visitor 字段
        serverName: proxyItem.serverName,
        serverUser: proxyItem.serverUser,
        bindAddr: proxyItem.bindAddr || '',
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
        // 访客组网 (vnet) 插件回填
        visitorPlugin: kind === 'visitor' ? pl.type : undefined,
        destinationIP: kind === 'visitor' ? pl.destinationIP : undefined,
      });
    } else {
      proxyForm.resetFields();
      proxyForm.setFieldsValue({
        kind: initialKind,
        type: initialKind === 'visitor' ? 'stcp' : 'tcp',
        localIP: '0.0.0.0',
        bindAddr: '0.0.0.0',
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
                renderItem={(item, index) => {
                  const isActive = item.id === activeConfigId;
                  const isRunning = item.state === 'started';

                  // 拖拽排序：整张卡片作为放置目标，仅卡内手柄(HolderOutlined)可发起拖拽，
                  // 其他区域(点击=选中)不触发，防误操作。
                  const dropProps = {
                    onDragOver: (e: DragEvent<HTMLDivElement>) => {
                      if (configDragIndexRef.current === null) return;
                      e.preventDefault();
                      if (configDragOverIndex !== index) setConfigDragOverIndex(index);
                    },
                    onDrop: (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); handleConfigReorder(index); },
                  };
                  const dropStyle: CSSProperties = configDragOverIndex === index
                    ? { outline: `2px dashed ${token.colorPrimary}`, outlineOffset: 1, borderRadius: 10 }
                    : {};
                  const dragHandle = (
                    <span
                      draggable
                      title="拖动排序"
                      onClick={(e) => e.stopPropagation()}
                      onDragStart={(e: DragEvent<HTMLSpanElement>) => { configDragIndexRef.current = index; e.dataTransfer.effectAllowed = 'move'; }}
                      onDragEnd={() => { configDragIndexRef.current = null; setConfigDragOverIndex(null); }}
                      style={{ cursor: 'grab', color: token.colorTextQuaternary, display: 'inline-flex', flex: '0 0 auto' }}
                    >
                      <HolderOutlined />
                    </span>
                  );

                  // 紧凑模式：只显示名字 + 状态圆点 + 启停按钮，省去 ID 与克隆/删除按钮
                  // 完整功能（重载/克隆/导出/删除）通过右键菜单暴露
                  if (compactList) {
                    return (
                      <div {...dropProps} style={dropStyle}>
                      <Dropdown menu={buildContextMenu(item)} trigger={['contextMenu']}>
                        <Tooltip title={`${item.name || item.id} (ID: ${item.id}) · 拖动左侧手柄排序 · 右键可重载 / 克隆 / 导出 / 删除`} placement="right">
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
                              {dragHandle}
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
                      </div>
                    );
                  }

                  return (
                    <div {...dropProps} style={dropStyle}>
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
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
                          <span style={{ marginTop: 2 }}>{dragHandle}</span>
                          <div style={{ minWidth: 0 }}>
                            <Text strong style={{ fontSize: '15px' }}>{item.name || item.id}</Text>
                            <div><Text type="secondary" style={{ fontSize: '12px' }}>ID: {item.id}</Text></div>
                          </div>
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
                    </div>
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
                        {selectedProxyKeys.length > 0 && (
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
                            padding: '8px 12px', borderRadius: 8,
                            background: 'rgba(22,119,255,0.08)',
                          }}>
                            <Text>已选 <Text strong>{selectedProxyKeys.length}</Text> 项</Text>
                            <Tooltip title={configs.filter((c) => c.id !== activeConfigId).length === 0 ? '暂无其他实例可迁移' : ''}>
                              <Button
                                size="small"
                                icon={<SwapOutlined />}
                                disabled={configs.filter((c) => c.id !== activeConfigId).length === 0}
                                onClick={() => setMigrateModalOpen(true)}
                              >
                                迁移到…
                              </Button>
                            </Tooltip>
                            <Popconfirm
                              title={`确定删除选中的 ${selectedProxyKeys.length} 条规则？`}
                              description="删除后无法恢复。"
                              onConfirm={handleBatchDelete}
                              okText="删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                            >
                              <Button size="small" danger icon={<DeleteOutlined />}>批量删除</Button>
                            </Popconfirm>
                            <Button size="small" type="text" onClick={() => setSelectedProxyKeys([])}>
                              取消选择
                            </Button>
                          </div>
                        )}
                        <Table
                          dataSource={proxies}
                          loading={proxiesLoading}
                          rowKey="name"
                          size="small"
                          pagination={false}
                          style={{ background: 'transparent' }}
                          className="custom-table"
                          rowSelection={{
                            selectedRowKeys: selectedProxyKeys,
                            onChange: (keys) => setSelectedProxyKeys(keys as string[]),
                          }}
                          onRow={(_, index) => ({
                            onDragOver: (e: DragEvent<HTMLTableRowElement>) => {
                              if (dragIndexRef.current === null || index === undefined) return;
                              e.preventDefault();
                              if (dragOverIndex !== index) setDragOverIndex(index);
                            },
                            onDrop: (e: DragEvent<HTMLTableRowElement>) => {
                              if (index === undefined) return;
                              e.preventDefault();
                              handleProxyDrop(index);
                            },
                            style: dragOverIndex === index
                              ? { background: 'rgba(22,119,255,0.12)' }
                              : undefined,
                          })}
                          columns={[
                            {
                              title: '',
                              key: '_drag',
                              width: 36,
                              render: (_, __, index) => (
                                <span
                                  title="拖动此处可上下排序"
                                  style={{ cursor: 'grab', color: 'var(--ant-color-text-quaternary, #bbb)', display: 'inline-flex', padding: '0 2px' }}
                                  draggable
                                  onDragStart={(e: DragEvent<HTMLSpanElement>) => {
                                    dragIndexRef.current = index;
                                    e.dataTransfer.effectAllowed = 'move';
                                  }}
                                  onDragEnd={() => {
                                    dragIndexRef.current = null;
                                    setDragOverIndex(null);
                                  }}
                                >
                                  <HolderOutlined />
                                </span>
                              ),
                            },
                            {
                              title: '名称',
                              dataIndex: 'name',
                              render: (_, record) => (
                                <Space size={6} style={{ flexWrap: 'nowrap' }}>
                                  {record._kind === 'visitor'
                                    ? <Tag color="purple" bordered={false}>访客</Tag>
                                    : <Tag color="geekblue" bordered={false}>代理</Tag>}
                                  <Text style={{ whiteSpace: 'nowrap' }}>{record.name}</Text>
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
                              width: 210,
                              render: (_, record) => {
                                const val = record._kind === 'visitor'
                                  ? `${record.bindAddr || '127.0.0.1'}:${record.bindPort ?? '-'}`
                                  : `${record.local_ip || record.localIP || '-'}:${record.local_port || record.localPort || '-'}`;
                                // 限宽 + 省略号；hover 出完整值；尾部一键复制（复制完整值，非截断后的）。
                                return (
                                  <Text
                                    type="secondary"
                                    style={{ maxWidth: 188, fontSize: 13 }}
                                    ellipsis={{ tooltip: val }}
                                    copyable={{ text: val, tooltips: ['复制', '已复制'] }}
                                  >
                                    {val}
                                  </Text>
                                );
                              }
                            },
                            {
                              title: '远端 / 服务名',
                              width: 200,
                              render: (_, record) => {
                                // 主信息（服务名/域名/端口）+ 访客的次要信息（用户名）分两行紧凑展示；
                                // 整列限宽 + 省略号，hover 出完整详情，避免长串撑爆表格。
                                let primary = '—';
                                let sub = '';
                                if (record._kind === 'visitor') {
                                  primary = record.serverName || '—';
                                  sub = record.serverUser || '';
                                } else if (record.type === 'http' || record.type === 'https') {
                                  const domains = record.customDomains;
                                  primary = domains && domains.length ? domains.join(', ') : (record.subdomain ? `*.${record.subdomain}` : '—');
                                } else if (record.type === 'tcpmux') {
                                  const domains = record.customDomains;
                                  primary = domains && domains.length ? domains.join(', ') : (record.multiplexer || '—');
                                } else {
                                  primary = record.remotePort != null ? String(record.remotePort) : '—';
                                }
                                const tip = record._kind === 'visitor'
                                  ? `服务名：${primary}${sub ? `\n用户：${sub}` : ''}`
                                  : primary;
                                const ellip: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
                                return (
                                  <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>} styles={{ root: { maxWidth: 360 } }}>
                                    <div style={{ maxWidth: 200, lineHeight: 1.25 }}>
                                      <div style={ellip}><Text style={{ fontSize: 13 }}>{primary}</Text></div>
                                      {sub && (
                                        <div style={ellip}>
                                          <Text type="secondary" style={{ fontSize: 11 }}>
                                            <UserOutlined style={{ marginRight: 3, opacity: 0.65 }} />{sub}
                                          </Text>
                                        </div>
                                      )}
                                    </div>
                                  </Tooltip>
                                );
                              }
                            },
                            {
                              title: '运行状态',
                              render: (_, record) => {
                                // 访客模式：本地绑定一个端口供访问，没有服务端运行态。
                                // 运行状态列改为「访问」文字按钮：新标签打开 当前协议//当前主机:bindPort。
                                if (record._kind === 'visitor') {
                                  if (record.disabled) return <Tag>已禁用</Tag>;
                                  const bindPort = record.bindPort;
                                  if (bindPort === undefined || bindPort === null || bindPort === '') return <Tag>—</Tag>;
                                  const url = `${window.location.protocol}//${window.location.hostname}:${bindPort}`;
                                  return (
                                    <Tooltip title={`在新标签打开 ${url}`}>
                                      <Button
                                        type="link"
                                        size="small"
                                        style={{ padding: 0, height: 'auto' }}
                                        onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                                      >
                                        访问
                                      </Button>
                                    </Tooltip>
                                  );
                                }
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
                                        <InputNumber min={1} style={{ width: '100%' }} placeholder="默认 10" />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item label={<span>保活心跳间隔 (秒)</span>} name="heartbeatInterval">
                                        <InputNumber min={1} style={{ width: '100%' }} placeholder="默认 20（CF 代理建议）" />
                                      </Form.Item>
                                    </Col>
                                    <Col span={12}>
                                      <Form.Item label={<span>心跳超时阈值 (秒)</span>} name="heartbeatTimeout">
                                        <InputNumber min={1} style={{ width: '100%' }} placeholder="默认 90" />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item label={<span>连接池初始数量 (pool_count)</span>} name="poolCount">
                                        <InputNumber min={0} max={100} style={{ width: '100%' }} placeholder="默认 5" />
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
                            },
                            {
                              key: 'vnet',
                              label: '组网 (VNet)',
                              forceRender: true,
                              children: (
                                <div>
                                  <Alert
                                    type="warning"
                                    showIcon
                                    style={{ marginBottom: 16 }}
                                    message="组网网关 / 虚拟网络 (vnet · 实验性)"
                                    description={
                                      <span>
                                        让多台装有本系统的机器通过虚拟 IP（如 100.86.0.x）互相访问。基于 frp 的 VirtualNet（上游 Alpha 实验特性，
                                        经 frps 中转、非 p2p）：<b>仅支持 Linux/macOS</b>，需 root/CAP_NET_ADMIN 权限创建虚拟网卡，Windows 不支持。
                                        开启后：① 为本机分配一个虚拟地址；② 在「代理穿透规则」加一条 <b>STCP + virtual_net 插件</b> 把本节点暴露出去；
                                        ③ 加「访客 + virtual_net + 目标虚拟 IP」去访问别的节点。
                                      </span>
                                    }
                                  />
                                  <Row gutter={16}>
                                    <Col span={12}>
                                      <Form.Item
                                        label={<span>开启虚拟网络 (featureGates.VirtualNet)</span>}
                                        name="virtualNetEnabled"
                                        valuePropName="checked"
                                        initialValue={false}
                                      >
                                        <Switch checkedChildren="已开启" unCheckedChildren="未启用" />
                                      </Form.Item>
                                    </Col>
                                  </Row>
                                  <Form.Item
                                    noStyle
                                    shouldUpdate={(prevValues, currentValues) => prevValues.virtualNetEnabled !== currentValues.virtualNetEnabled}
                                  >
                                    {({ getFieldValue }) => getFieldValue('virtualNetEnabled') ? (
                                      <Form.Item
                                        label={<span>本机虚拟地址 (virtualNet.address)</span>}
                                        name="virtualNetAddress"
                                        rules={[{ required: true, message: '请填写本机在虚拟网络中的 CIDR 地址' }]}
                                        tooltip="本节点在虚拟网络中的地址，CIDR 形式；同一虚拟网内各节点地址不能重复，如 100.86.0.2/24"
                                      >
                                        <Input placeholder="100.86.0.2/24" style={{ maxWidth: 320 }} />
                                      </Form.Item>
                                    ) : null}
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
                    <Input
                      placeholder="与对端服务端代理相同的 secretKey"
                      addonAfter={(
                        <Tooltip title="随机生成强密钥（首尾大写/数字，去易混字符）">
                          <a onClick={() => proxyForm.setFieldsValue({ secretKey: genSecretKey() })}>
                            <ThunderboltOutlined /> 随机
                          </a>
                        </Tooltip>
                      )}
                    />
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
                      <Form.Item label="本地绑定地址 bindAddr" name="bindAddr" tooltip="留空=frp 默认 127.0.0.1(仅回环); 0.0.0.0=所有网卡(LAN 可达)">
                        <Input placeholder="0.0.0.0" />
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
                      <Form.Item
                        label="加密传输"
                        name="useEncryption"
                        valuePropName="checked"
                        tooltip="必须与服务端代理 (proxy) 的「加密传输」设置完全一致，否则隧道虽能打通但数据为乱码、无法访问。XTCP 走 QUIC 时链路本身已 TLS 加密，此项通常保持关闭即可。"
                      >
                        <Switch checkedChildren="启用" unCheckedChildren="关闭" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        label="压缩传输"
                        name="useCompression"
                        valuePropName="checked"
                        tooltip="必须与服务端代理 (proxy) 的「压缩传输」设置完全一致。"
                      >
                        <Switch checkedChildren="启用" unCheckedChildren="关闭" />
                      </Form.Item>
                    </Col>
                  </Row>

                  {/* ===== 组网网关 (vnet) 访客插件 ===== */}
                  <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 12, marginTop: 4 }}>
                    <Text strong style={{ fontSize: 13 }}>组网网关 (VNet) <Tag color="orange">实验性</Tag></Text>
                    <Form.Item
                      label="访客插件 plugin"
                      name="visitorPlugin"
                      style={{ marginTop: 8 }}
                      tooltip="选择 virtual_net：本访客作为虚拟网络节点访问对端的虚拟 IP。需先在「常规配置 → 组网 (VNet)」开启 VirtualNet 并设置本机虚拟地址。仅 Linux/macOS。"
                    >
                      <Select
                        allowClear
                        placeholder="可选：选择 virtual_net 接入组网"
                        options={[{ value: 'virtual_net', label: 'virtual_net — 组网网关 (vnet)' }]}
                        onChange={(val) => { if (val === 'virtual_net') proxyForm.setFieldsValue({ bindPort: -1 }); }}
                      />
                    </Form.Item>
                    <Form.Item noStyle shouldUpdate={(p, c) => p.visitorPlugin !== c.visitorPlugin}>
                      {({ getFieldValue }) => getFieldValue('visitorPlugin') === 'virtual_net' ? (
                        <>
                          <Alert
                            type={detailConfig?.config?.featureGates?.VirtualNet && detailConfig?.config?.virtualNet?.address ? 'info' : 'warning'}
                            showIcon
                            style={{ margin: '8px 0 12px' }}
                            message={
                              detailConfig?.config?.featureGates?.VirtualNet && detailConfig?.config?.virtualNet?.address
                                ? <span>本机虚拟地址：<b>{detailConfig.config.virtualNet.address}</b> ✓（已在常规配置开启）</span>
                                : <span>⚠️ 本机<b>尚未开启虚拟网络或未设置地址</b>，请先到「常规配置 → 组网 (VNet)」开启并填写本机虚拟地址，否则本访客无法接入组网。</span>
                            }
                          />
                          <Form.Item
                            label="目标虚拟 IP destinationIP"
                            name="destinationIP"
                            rules={[{ required: true, message: '请输入对端节点的虚拟 IP' }]}
                            tooltip="对端节点在虚拟网络中的地址（单个 IP，非网段），如 100.86.0.1；选中后 bindPort 会自动设为 -1。"
                          >
                            <Input placeholder="100.86.0.1" />
                          </Form.Item>
                        </>
                      ) : null}
                    </Form.Item>
                  </div>

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
                  <Form.Item label="本地监听 IP" name="localIP" tooltip="留空=frp 默认 127.0.0.1">
                    <Input placeholder="0.0.0.0" disabled={usingPlugin} />
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
                      <Input
                        placeholder="访客端与服务端共享密钥"
                        addonAfter={(
                          <Tooltip title="随机生成强密钥（首尾大写/数字，去易混字符）">
                            <a onClick={() => proxyForm.setFieldsValue({ secretKey: genSecretKey() })}>
                              <ThunderboltOutlined /> 随机
                            </a>
                          </Tooltip>
                        )}
                      />
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

          {/* 传输层：加密 / 压缩（所有代理类型通用）。
              frp 中 proxy 与 visitor 各自按自身配置包装、互不协商：STCP/XTCP/SUDP
              与访客端成对，两端必须完全一致，否则隧道能建立但数据为乱码、无法访问。
              这也是「代理端无此开关、只在访客端能开 → 必然对不齐」历史坑的根治。 */}
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.kind !== cur.kind || prev.type !== cur.type}
          >
            {({ getFieldValue }) => {
              if (getFieldValue('kind') === 'visitor') return null;
              const type = getFieldValue('type');
              const paired = type === 'stcp' || type === 'sudp' || type === 'xtcp';
              return (
                <Row gutter={12}>
                  <Col span={12}>
                    <Form.Item
                      label="加密传输"
                      name="useEncryption"
                      valuePropName="checked"
                      tooltip={paired
                        ? '必须与访客端 (visitor) 的「加密传输」设置完全一致，否则 P2P/隧道虽能建立但数据为乱码、无法访问。XTCP 走 QUIC 时链路本身已 TLS 加密，此项通常保持关闭即可。'
                        : '作用于 frpc↔frps 链路；当传输层 TLS 已开启时通常无需再开。'}
                    >
                      <Switch checkedChildren="启用" unCheckedChildren="关闭" />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      label="压缩传输"
                      name="useCompression"
                      valuePropName="checked"
                      tooltip={paired
                        ? '必须与访客端 (visitor) 的「压缩传输」设置完全一致。'
                        : '作用于 frpc↔frps 链路。'}
                    >
                      <Switch checkedChildren="启用" unCheckedChildren="关闭" />
                    </Form.Item>
                  </Col>
                </Row>
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
                        { value: 'virtual_net', label: 'virtual_net — 组网网关 (vnet · 实验性)' },
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
                  {p === 'virtual_net' && (
                    <Alert
                      type={detailConfig?.config?.featureGates?.VirtualNet && detailConfig?.config?.virtualNet?.address ? 'info' : 'warning'}
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="组网网关 (vnet · 实验性)"
                      description={
                        <span>
                          {detailConfig?.config?.featureGates?.VirtualNet && detailConfig?.config?.virtualNet?.address ? (
                            <div style={{ marginBottom: 6 }}>本机虚拟地址：<b>{detailConfig.config.virtualNet.address}</b> ✓（已在常规配置开启）</div>
                          ) : (
                            <div style={{ marginBottom: 6 }}>⚠️ 本机<b>尚未开启虚拟网络或未设置地址</b>，请先到「常规配置 → 组网 (VNet)」开启 VirtualNet 并填写本机虚拟地址，否则本规则无法生效。</div>
                          )}
                          本代理把当前节点作为虚拟网络的<b>被访问端</b>。请选择 <b>STCP</b> 类型并设置<b>共享密钥</b>；
                          对端用「访客 + virtual_net + 目标虚拟 IP」即可访问本节点。仅支持 Linux/macOS。
                        </span>
                      }
                    />
                  )}
                </>
              );
            }}
          </Form.Item>
        </Form>
      </Drawer>

      {/* 批量迁移规则到其他 FRPS 实例 */}
      <Modal
        title="迁移规则到其他实例"
        open={migrateModalOpen}
        onCancel={() => { setMigrateModalOpen(false); setMigrateTargetId(''); }}
        onOk={handleMigrate}
        okText="迁移"
        cancelText="取消"
        okButtonProps={{ disabled: !migrateTargetId, loading: migrating }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Text>
            将选中的 <Text strong>{selectedProxyKeys.length}</Text> 条规则从当前实例
            搬移到目标实例（原子操作：先写入目标、再从当前移除，名称冲突会整体中止）。
          </Text>
          <Select
            style={{ width: '100%' }}
            placeholder="选择目标 FRPS 实例"
            value={migrateTargetId || undefined}
            onChange={setMigrateTargetId}
            options={configs
              .filter((c) => c.id !== activeConfigId)
              .map((c) => ({ value: c.id, label: c.name || c.id }))}
            notFoundContent="没有其他可迁移的实例"
          />
        </Space>
      </Modal>
    </div>
  );
};

export default Configs;
