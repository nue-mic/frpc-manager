import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Modal,
  Tabs,
  Segmented,
  Space,
  Button,
  App,
  Typography,
  Alert,
  Input,
  Table,
  Select,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CopyOutlined,
  DownloadOutlined,
  ReloadOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  ImportOutlined,
  EditOutlined,
  MinusCircleOutlined,
  ArrowRightOutlined,
  LockOutlined,
  InboxOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import client from '../api/client';

const { Text } = Typography;
const { TextArea } = Input;
const roExt = [StreamLanguage.define(toml), EditorView.editable.of(false)];

export interface RulesTransferModalProps {
  open: boolean;
  configId: string;
  configName: string;
  /** 勾选的规则名（批量导出用），空数组表示无勾选 */
  selectedNames: string[];
  /** 初始 Tab：'export' | 'import' */
  initialTab?: 'export' | 'import';
  /** 粘贴触发时预填到导入框的文本 */
  initialContent?: string;
  onClose: () => void;
  /** 导入成功后回调（刷新表格） */
  onImported?: () => void;
}

type ExportFormat = 'toml' | 'portable';
type ExportKind = 'all' | 'proxy' | 'visitor';
type ExportScope = 'all' | 'selected';

type RowAction = 'pair' | 'as_proxy' | 'as_visitor' | 'overwrite' | 'rename' | 'skip';

/** camelCase Typed*（proxy 或 visitor）运行时对象，字段随类型而变，故为开放记录 */
type RuleRaw = Record<string, unknown>;
/** 后端建议的配对访客（camelCase），含 name/bindAddr/bindPort 等 */
type SuggestedVisitor = Record<string, unknown> & {
  name?: string;
  bindAddr?: string;
  bindPort?: number;
  transport?: { useEncryption?: boolean; useCompression?: boolean };
};

/** /proxies/parse 返回的来源信息 */
interface ParseSource {
  configId?: string;
  configName?: string;
  user?: string;
  daemon?: string;
  frp?: string;
}

/** /proxies/parse 返回的单条 item */
interface ParseItem {
  kind: 'proxy' | 'visitor';
  name: string;
  type: string;
  summary: string;
  raw: RuleRaw;
  pairable?: boolean;
  suggestedVisitor?: SuggestedVisitor;
  conflict?: string | null;
  error?: string;
}

interface ImportResult {
  name: string;
  finalName?: string;
  status: string;
  error?: string;
}

interface ParsedRow {
  key: string;
  kind: 'proxy' | 'visitor';
  name: string;
  type: string;
  summary: string;
  raw: RuleRaw; // camelCase Typed*（proxy 或 visitor）
  pairable?: boolean;
  suggestedVisitor?: SuggestedVisitor; // camelCase visitor
  conflict?: string | null;
  action: RowAction;
  bindAddr: string; // 配对访客可编辑
  bindPort?: number;
  editName: string; // 配对访客 / 重命名后的名字
}

/** 该行的智能默认动作 */
const defaultActionOf = (r: Pick<ParsedRow, 'pairable' | 'conflict' | 'kind'>): RowAction =>
  r.pairable ? 'pair' : r.conflict ? 'skip' : r.kind === 'visitor' ? 'as_visitor' : 'as_proxy';

/** 粗筛：内容像不像可导入的规则（避免对半截输入狂调后端） */
const looksImportable = (t: string): boolean => {
  const s = t.trim();
  if (!s) return false;
  if (s.startsWith('{') && s.includes('"frpcManagerExport"')) return true;
  return s.includes('[[proxies]]') || s.includes('[[visitors]]');
};

/** 统一提取 axios/后端错误信息 */
const errMessage = (e: unknown): string => {
  const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
  return err?.response?.data?.error?.message || err?.message || '';
};

const copyText = async (
  s: string,
  msg: { success: (m: string) => void; error: (m: string) => void },
) => {
  try {
    await navigator.clipboard.writeText(s);
    msg.success('已复制到剪贴板');
  } catch {
    msg.error('复制失败，浏览器可能不允许访问剪贴板');
  }
};

const download = (s: string, filename: string) => {
  const blob = new Blob([s], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const kindTag = (k: 'proxy' | 'visitor') =>
  k === 'visitor' ? (
    <Tag color="purple" bordered={false}>
      访客
    </Tag>
  ) : (
    <Tag color="geekblue" bordered={false}>
      代理
    </Tag>
  );

const RulesTransferModal: React.FC<RulesTransferModalProps> = (props) => {
  const { open, configId, configName, selectedNames, initialTab, onClose, onImported, initialContent } =
    props;
  const { message } = App.useApp();
  const [tab, setTab] = useState<'export' | 'import'>(initialTab || 'export');

  // ---- 导出状态 ----
  const [format, setFormat] = useState<ExportFormat>('portable');
  const [kind, setKind] = useState<ExportKind>('all');
  const [scope, setScope] = useState<ExportScope>(selectedNames.length > 0 ? 'selected' : 'all');
  const [proxiesToml, setProxiesToml] = useState('');
  const [visitorsToml, setVisitorsToml] = useState('');
  const [portableJson, setPortableJson] = useState('');
  const [filename, setFilename] = useState('rules.json');
  const [counts, setCounts] = useState<{ proxies: number; visitors: number }>({ proxies: 0, visitors: 0 });
  const [loadingExport, setLoadingExport] = useState(false);

  // ---- 导入状态 ----
  const [content, setContent] = useState(initialContent || '');
  const [parsing, setParsing] = useState(false);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [detected, setDetected] = useState('');
  const [source, setSource] = useState<ParseSource | null>(null);
  const [globalErr, setGlobalErr] = useState('');
  const [importing, setImporting] = useState(false);

  const runExport = useCallback(async () => {
    setLoadingExport(true);
    try {
      const body = {
        format,
        kind,
        names: scope === 'selected' ? selectedNames : null,
      };
      const { data } = await client.post(`/api/v1/configs/${configId}/proxies/export`, body);
      setFilename(data.filename || 'rules.json');
      setCounts(data.counts || { proxies: 0, visitors: 0 });
      if (format === 'portable') {
        setPortableJson(data.portableJson || '');
        setProxiesToml('');
        setVisitorsToml('');
      } else {
        setProxiesToml(data.proxiesToml || '');
        setVisitorsToml(data.visitorsToml || '');
        setPortableJson('');
      }
    } catch (e: unknown) {
      message.error('导出失败：' + errMessage(e));
    } finally {
      setLoadingExport(false);
    }
  }, [format, kind, scope, selectedNames, configId, message]);

  // 导出 Tab：打开 / 切换任一选项时自动生成（免点击）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && tab === 'export') runExport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, format, kind, scope]);

  const runParse = useCallback(
    async (text: string) => {
      const c = (text ?? content).trim();
      if (!c) {
        message.warning('请先粘贴或输入要导入的内容');
        return;
      }
      setParsing(true);
      try {
        const { data } = await client.post(`/api/v1/configs/${configId}/proxies/parse`, { content: c });
        setDetected(data.detectedFormat || '');
        setSource((data.source as ParseSource) || null);
        setGlobalErr(data.globalError || '');
        const items = (data.items || []) as ParseItem[];
        setRows(
          items.map((it, i): ParsedRow => {
            const pairable = it.kind === 'proxy' && it.pairable;
            const sv = it.suggestedVisitor;
            return {
              key: `${it.kind}-${it.name}-${i}`,
              kind: it.kind,
              name: it.name,
              type: it.type,
              summary: it.summary,
              raw: it.raw,
              pairable,
              suggestedVisitor: sv,
              conflict: it.conflict,
              action: defaultActionOf({ pairable, conflict: it.conflict, kind: it.kind }),
              bindAddr: sv?.bindAddr || '0.0.0.0',
              bindPort: sv?.bindPort,
              editName: pairable ? sv?.name || it.name : it.name,
            };
          }),
        );
      } catch (e: unknown) {
        message.error('解析失败：' + errMessage(e));
      } finally {
        setParsing(false);
      }
    },
    [content, configId, message],
  );

  const resetParse = useCallback(() => {
    setRows([]);
    setDetected('');
    setSource(null);
    setGlobalErr('');
  }, []);

  // 导入 Tab：内容变化时防抖自动解析（免点击）。内容不像规则时不触发。
  useEffect(() => {
    const c = content.trim();
    if (!c) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      resetParse();
      return;
    }
    if (!looksImportable(c)) return;
    const t = setTimeout(() => runParse(c), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  const patchRow = useCallback((key: string, patch: Partial<ParsedRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const acceptAllRecommended = useCallback(() => {
    setRows((prev) => prev.map((r) => ({ ...r, action: defaultActionOf(r) })));
  }, []);

  const runImport = useCallback(async () => {
    const items = rows
      .filter((r) => r.action !== 'skip')
      .map((r) => {
        if (r.action === 'pair') {
          const v = { ...r.suggestedVisitor, name: r.editName, bindAddr: r.bindAddr, bindPort: r.bindPort };
          return { kind: 'visitor', action: 'create', visitor: v };
        }
        const action = r.action === 'rename' ? 'rename' : r.action === 'overwrite' ? 'overwrite' : 'create';
        const payload: Record<string, unknown> = { kind: r.kind, action };
        if (action === 'rename') payload.newName = r.editName;
        if (r.kind === 'visitor') payload.visitor = r.raw;
        else payload.proxy = r.raw;
        return payload;
      });
    if (items.length === 0) {
      message.warning('没有要导入的项');
      return;
    }
    setImporting(true);
    try {
      const { data } = await client.post(`/api/v1/configs/${configId}/proxies/import`, { items });
      message.success(`导入完成：新增/更新 ${data.applied}，跳过 ${data.skipped}，失败 ${data.failed}`);
      if (data.failed > 0) {
        const fails = ((data.results || []) as ImportResult[]).filter((x) => x.status === 'failed');
        Modal.warning({
          title: '部分项导入失败',
          content: fails.map((f) => `${f.name}: ${f.error}`).join('\n'),
        });
      }
      onImported?.();
      onClose();
    } catch (e: unknown) {
      message.error('导入失败：' + errMessage(e));
    } finally {
      setImporting(false);
    }
  }, [rows, configId, message, onImported, onClose]);

  // 汇总各动作计数
  const summary = useMemo(() => {
    const c = { pair: 0, importN: 0, overwrite: 0, rename: 0, skip: 0 };
    rows.forEach((r) => {
      if (r.action === 'skip') c.skip++;
      else if (r.action === 'pair') c.pair++;
      else if (r.action === 'overwrite') c.overwrite++;
      else if (r.action === 'rename') c.rename++;
      else c.importN++;
    });
    return c;
  }, [rows]);

  const applyCount = rows.filter((r) => r.action !== 'skip').length;

  const actionOptions = (r: ParsedRow): { label: React.ReactNode; value: RowAction }[] => {
    const opts: { label: React.ReactNode; value: RowAction }[] = [];
    if (r.pairable) {
      opts.push({
        label: (
          <>
            <ThunderboltOutlined /> 生成配对访客
          </>
        ),
        value: 'pair',
      });
      opts.push({
        label: (
          <>
            <ImportOutlined /> 原样导入为代理
          </>
        ),
        value: 'as_proxy',
      });
    } else if (r.kind === 'visitor') {
      opts.push({
        label: (
          <>
            <ImportOutlined /> 导入为访客
          </>
        ),
        value: 'as_visitor',
      });
    } else {
      opts.push({
        label: (
          <>
            <ImportOutlined /> 导入为代理
          </>
        ),
        value: 'as_proxy',
      });
    }
    if (r.conflict === 'name_exists') {
      opts.push({ label: <>覆盖现有</>, value: 'overwrite' });
      opts.push({
        label: (
          <>
            <EditOutlined /> 重命名
          </>
        ),
        value: 'rename',
      });
    }
    opts.push({
      label: (
        <>
          <MinusCircleOutlined /> 跳过
        </>
      ),
      value: 'skip',
    });
    return opts;
  };

  const editorBox = (value: string, label: string, fname: string) => (
    <div style={{ marginBottom: 14 }}>
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 6 }}>
        <Text strong>{label}</Text>
        <Space>
          <Button size="small" icon={<CopyOutlined />} disabled={!value} onClick={() => copyText(value, message)}>
            复制
          </Button>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            disabled={!value}
            onClick={() => download(value, fname)}
          >
            下载
          </Button>
        </Space>
      </Space>
      <div style={{ border: '1px solid #1f2933', borderRadius: 8, overflow: 'hidden', background: '#0b0f14' }}>
        <CodeMirror
          value={value}
          theme={oneDark}
          extensions={roExt}
          readOnly
          height="200px"
          maxHeight="38vh"
          basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: false }}
        />
      </div>
    </div>
  );

  const exportTab = (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Alert
        type="info"
        showIcon
        message="导出的「可移植信封」可直接在另一台系统的配置页粘贴 → 自动生成配对访客。含 secretKey（配对所需），勿公开分享；不含服务器地址与 token。"
        style={{ fontSize: 12 }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <Segmented
          size="small"
          value={scope}
          onChange={(v) => setScope(v as ExportScope)}
          options={[
            { label: '全部', value: 'all' },
            { label: `已选 ${selectedNames.length} 项`, value: 'selected', disabled: selectedNames.length === 0 },
          ]}
        />
        <Segmented
          size="small"
          value={kind}
          onChange={(v) => setKind(v as ExportKind)}
          options={[
            { label: '代理+访客', value: 'all' },
            { label: '仅代理', value: 'proxy' },
            { label: '仅访客', value: 'visitor' },
          ]}
        />
        <Segmented
          size="small"
          value={format}
          onChange={(v) => setFormat(v as ExportFormat)}
          options={[
            { label: '可移植信封', value: 'portable' },
            { label: 'TOML', value: 'toml' },
          ]}
        />
        <Tag color="geekblue" bordered={false}>
          {counts.proxies} 代理
        </Tag>
        <Tag color="purple" bordered={false}>
          {counts.visitors} 访客
        </Tag>
        <Tooltip title="刷新">
          <Button size="small" type="text" icon={<ReloadOutlined spin={loadingExport} />} onClick={runExport} />
        </Tooltip>
      </div>
      {format === 'toml' ? (
        <>
          {editorBox(proxiesToml, '代理 TOML', filename.replace(/\.(toml|json)$/, '-proxies.toml'))}
          {editorBox(visitorsToml, '访客 TOML', filename.replace(/\.(toml|json)$/, '-visitors.toml'))}
        </>
      ) : (
        editorBox(portableJson, '可移植信封 (JSON)', filename)
      )}
    </Space>
  );

  const columns: ColumnsType<ParsedRow> = [
    {
      title: '规则',
      dataIndex: 'name',
      width: 200,
      render: (name: string, r) => (
        <Space size={4} wrap>
          {kindTag(r.kind)}
          <Text strong>{name}</Text>
          <Tag bordered={false} style={{ fontSize: 11 }}>
            {r.type}
          </Tag>
          {r.conflict === 'name_exists' && (
            <Tag color="red" bordered={false}>
              同名已存在
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 168,
      render: (action: RowAction, r) => (
        <Select<RowAction>
          size="small"
          style={{ width: 158 }}
          value={action}
          options={actionOptions(r)}
          onChange={(v) => patchRow(r.key, { action: v })}
        />
      ),
    },
    {
      title: '结果',
      dataIndex: 'result',
      render: (_: unknown, r) => {
        if (r.action === 'skip') {
          return (
            <Text type="secondary" style={{ fontSize: 12 }}>
              不导入
            </Text>
          );
        }
        if (r.action === 'pair') {
          return (
            <Space size={6} wrap>
              <ArrowRightOutlined style={{ color: '#722ed1' }} />
              {kindTag('visitor')}
              <Input
                size="small"
                style={{ width: 120 }}
                value={r.editName}
                placeholder="访客名"
                onChange={(e) => patchRow(r.key, { editName: e.target.value })}
              />
              <Input
                size="small"
                style={{ width: 96 }}
                value={r.bindAddr}
                placeholder="bindAddr"
                onChange={(e) => patchRow(r.key, { bindAddr: e.target.value })}
              />
              <span style={{ color: '#888' }}>:</span>
              <Input
                size="small"
                style={{ width: 72 }}
                type="number"
                value={r.bindPort}
                placeholder="端口"
                onChange={(e) =>
                  patchRow(r.key, { bindPort: e.target.value ? Number(e.target.value) : undefined })
                }
              />
              <Tooltip title="访客的加密/压缩已与源代理强制对齐，两端不会对不上">
                <Tag icon={<LockOutlined />} color="green" bordered={false} style={{ fontSize: 11 }}>
                  加密·压缩已对齐
                </Tag>
              </Tooltip>
            </Space>
          );
        }
        if (r.action === 'rename') {
          return (
            <Space size={6}>
              <ArrowRightOutlined />
              <Text type="secondary" style={{ fontSize: 12 }}>
                重命名为
              </Text>
              <Input
                size="small"
                style={{ width: 140 }}
                value={r.editName}
                placeholder="新名称"
                onChange={(e) => patchRow(r.key, { editName: e.target.value })}
              />
            </Space>
          );
        }
        if (r.action === 'overwrite') {
          return (
            <Space size={6}>
              <ArrowRightOutlined />
              <Text type="warning" style={{ fontSize: 12 }}>
                覆盖现有「{r.name}」
              </Text>
            </Space>
          );
        }
        // as_proxy / as_visitor
        return (
          <Space size={6}>
            <ArrowRightOutlined />
            <Text type="secondary" style={{ fontSize: 12 }}>
              新建{r.kind === 'visitor' ? '访客' : '代理'}「{r.name}」
            </Text>
          </Space>
        );
      },
    },
  ];

  const summaryParts: string[] = [];
  if (summary.pair) summaryParts.push(`创建 ${summary.pair} 个配对访客`);
  if (summary.importN) summaryParts.push(`导入 ${summary.importN}`);
  if (summary.overwrite) summaryParts.push(`覆盖 ${summary.overwrite}`);
  if (summary.rename) summaryParts.push(`重命名 ${summary.rename}`);
  if (summary.skip) summaryParts.push(`跳过 ${summary.skip}`);

  const importTab = (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <TextArea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={4}
        placeholder="粘贴可移植信封 JSON 或 TOML 片段 —— 内容有效会自动解析"
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />

      {/* 来源横幅 */}
      {(source || detected) && (
        <Alert
          type="success"
          showIcon
          icon={<InboxOutlined />}
          style={{ fontSize: 12 }}
          message={
            <Space size={6} wrap>
              {source?.configName && (
                <span>
                  来自「<Text strong>{source.configName}</Text>」
                </span>
              )}
              {source?.user && <Tag bordered={false}>节点 {source.user}</Tag>}
              {detected && <Tag color="cyan" bordered={false}>识别：{detected === 'portable' ? '可移植信封' : detected}</Tag>}
              {parsing && <Text type="secondary">解析中…</Text>}
            </Space>
          }
        />
      )}

      {globalErr && <Alert type="error" showIcon message={globalErr} />}

      {/* 汇总行 + 一键全部接受 */}
      {rows.length > 0 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <Space size={4} wrap>
            <CheckCircleOutlined style={{ color: '#52c41a' }} />
            <Text>{summaryParts.length ? summaryParts.join(' · ') : '全部跳过'}</Text>
          </Space>
          <Button size="small" icon={<ThunderboltOutlined />} onClick={acceptAllRecommended}>
            全部接受推荐
          </Button>
        </div>
      )}

      <Table<ParsedRow>
        size="small"
        rowKey="key"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ y: 300 }}
        onRow={(r) => ({
          style: r.conflict === 'name_exists' ? { background: 'rgba(255,77,79,0.06)' } : {},
        })}
        locale={{ emptyText: parsing ? '解析中…' : '粘贴内容后将在此显示可导入的规则' }}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button size="small" type="text" loading={parsing} onClick={() => runParse(content)}>
          重新解析
        </Button>
        <Button type="primary" loading={importing} disabled={applyCount === 0} onClick={runImport}>
          确认导入 {applyCount} 项
        </Button>
      </div>
    </Space>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={820}
      destroyOnClose
      title={
        <Space size={8}>
          <SwapOutlined style={{ color: '#1677ff' }} />
          <span>规则导入导出</span>
          <Text type="secondary" style={{ fontWeight: 400, fontSize: 13 }}>
            · {configName}
          </Text>
        </Space>
      }
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'export' | 'import')}
        items={[
          {
            key: 'export',
            label: (
              <>
                <DownloadOutlined /> 导出
              </>
            ),
            children: exportTab,
          },
          {
            key: 'import',
            label: (
              <>
                <ImportOutlined /> 导入
              </>
            ),
            children: importTab,
          },
        ]}
      />
    </Modal>
  );
};

export default RulesTransferModal;
