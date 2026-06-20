import { useState, useCallback, useEffect } from 'react';
import {
  Modal,
  Tabs,
  Radio,
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
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
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
};

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
  newName?: string;
  editName: string; // 配对访客 / 重命名后的名字
}

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

const RulesTransferModal: React.FC<RulesTransferModalProps> = (props) => {
  const { open, configId, configName, selectedNames, initialTab, onClose, onImported, initialContent } = props;
  const { message } = App.useApp();
  const [tab, setTab] = useState<'export' | 'import'>(initialTab || 'export');

  // ---- 导出状态 ----
  const [format, setFormat] = useState<ExportFormat>('toml');
  const [kind, setKind] = useState<ExportKind>('all');
  const [scope, setScope] = useState<ExportScope>(selectedNames.length > 0 ? 'selected' : 'all');
  const [proxiesToml, setProxiesToml] = useState('');
  const [visitorsToml, setVisitorsToml] = useState('');
  const [portableJson, setPortableJson] = useState('');
  const [filename, setFilename] = useState('rules.toml');
  const [loadingExport, setLoadingExport] = useState(false);

  // ---- 导入状态 ----
  const [content, setContent] = useState(initialContent || '');
  const [parsing, setParsing] = useState(false);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [detected, setDetected] = useState('');
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
      setFilename(data.filename || 'rules.toml');
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
        setGlobalErr(data.globalError || '');
        const items = (data.items || []) as ParseItem[];
        setRows(
          items.map((it, i): ParsedRow => {
            const pairable = it.kind === 'proxy' && it.pairable;
            const sv = it.suggestedVisitor;
            const defaultAction: RowAction = pairable
              ? 'pair'
              : it.conflict
              ? 'skip'
              : it.kind === 'visitor'
              ? 'as_visitor'
              : 'as_proxy';
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
              action: defaultAction,
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

  // 粘贴方式打开弹窗时：预填内容并自动解析。
  // 此处为「外部输入 → 同步到内部受控态」的合理用法，故关闭对应告警。
  useEffect(() => {
    if (open && initialContent && initialContent.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContent(initialContent);
      runParse(initialContent);
    }
    // runParse 依赖稳定，仅需在 initialContent / open 变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent, open]);

  const patchRow = useCallback((key: string, patch: Partial<ParsedRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const actionOptions = (r: ParsedRow): { label: string; value: RowAction }[] => {
    const opts: { label: string; value: RowAction }[] = [];
    if (r.pairable) {
      opts.push({ label: '生成配对访客', value: 'pair' });
      opts.push({ label: '原样导入为代理', value: 'as_proxy' });
    } else if (r.kind === 'visitor') {
      opts.push({ label: '导入为访客', value: 'as_visitor' });
    } else {
      opts.push({ label: '导入为代理', value: 'as_proxy' });
    }
    if (r.conflict === 'name_exists') {
      opts.push({ label: '覆盖', value: 'overwrite' });
      opts.push({ label: '重命名', value: 'rename' });
    }
    opts.push({ label: '跳过', value: 'skip' });
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
          <Button size="small" icon={<DownloadOutlined />} disabled={!value} onClick={() => download(value, fname)}>
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
          height="220px"
          maxHeight="40vh"
          basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: false }}
        />
      </div>
    </div>
  );

  const exportTab = (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Alert
        type="warning"
        showIcon
        banner
        message="导出内容包含 STCP/XTCP/SUDP 的 secretKey（配对所需），请勿公开分享。不含服务器地址与鉴权 token。"
      />
      <Space wrap>
        <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)} optionType="button" size="small">
          <Radio.Button value="all">全部</Radio.Button>
          <Radio.Button value="selected" disabled={selectedNames.length === 0}>
            已选 {selectedNames.length} 项
          </Radio.Button>
        </Radio.Group>
        <Radio.Group value={kind} onChange={(e) => setKind(e.target.value)} optionType="button" size="small">
          <Radio.Button value="all">代理+访客</Radio.Button>
          <Radio.Button value="proxy">仅代理</Radio.Button>
          <Radio.Button value="visitor">仅访客</Radio.Button>
        </Radio.Group>
        <Radio.Group value={format} onChange={(e) => setFormat(e.target.value)} optionType="button" size="small">
          <Radio.Button value="toml">TOML</Radio.Button>
          <Radio.Button value="portable">可移植信封</Radio.Button>
        </Radio.Group>
        <Button type="primary" size="small" loading={loadingExport} onClick={runExport}>
          生成
        </Button>
      </Space>
      {format === 'toml' ? (
        <>
          {editorBox(proxiesToml, '代理 TOML', filename.replace('.toml', '-proxies.toml'))}
          {editorBox(visitorsToml, '访客 TOML', filename.replace('.toml', '-visitors.toml'))}
        </>
      ) : (
        editorBox(portableJson, '可移植信封 (JSON)', filename)
      )}
    </Space>
  );

  const columns: ColumnsType<ParsedRow> = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 70,
      render: (k: ParsedRow['kind']) =>
        k === 'visitor' ? <Tag color="purple">访客</Tag> : <Tag color="blue">代理</Tag>,
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 140,
      render: (name: string, r) => (
        <Space size={4} wrap>
          <Text>{name}</Text>
          {r.conflict === 'name_exists' && <Tag color="red">同名已存在</Tag>}
        </Space>
      ),
    },
    { title: 'type', dataIndex: 'type', width: 80 },
    {
      title: '摘要',
      dataIndex: 'summary',
      ellipsis: true,
      render: (s: string) => (
        <Tooltip title={s}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {s}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 160,
      render: (action: RowAction, r) => (
        <Select<RowAction>
          size="small"
          style={{ width: 150 }}
          value={action}
          options={actionOptions(r)}
          onChange={(v) => patchRow(r.key, { action: v })}
        />
      ),
    },
    {
      title: '配置',
      dataIndex: 'edit',
      width: 240,
      render: (_: unknown, r) => {
        if (r.action === 'pair') {
          return (
            <Space size={4} wrap>
              <Input
                size="small"
                style={{ width: 110 }}
                value={r.editName}
                placeholder="访客名"
                onChange={(e) => patchRow(r.key, { editName: e.target.value })}
              />
              <Input
                size="small"
                style={{ width: 100 }}
                value={r.bindAddr}
                placeholder="bindAddr"
                onChange={(e) => patchRow(r.key, { bindAddr: e.target.value })}
              />
              <Input
                size="small"
                style={{ width: 80 }}
                type="number"
                value={r.bindPort}
                placeholder="bindPort"
                onChange={(e) =>
                  patchRow(r.key, { bindPort: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </Space>
          );
        }
        if (r.action === 'rename') {
          return (
            <Input
              size="small"
              style={{ width: 130 }}
              value={r.editName}
              placeholder="新名称"
              onChange={(e) => patchRow(r.key, { editName: e.target.value })}
            />
          );
        }
        return (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        );
      },
    },
  ];

  const importTab = (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <TextArea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        placeholder="粘贴 TOML 片段或可移植信封 JSON"
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      <Space>
        <Button type="primary" size="small" loading={parsing} onClick={() => runParse(content)}>
          解析
        </Button>
        {detected && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            识别格式：{detected}
          </Text>
        )}
      </Space>
      {globalErr && <Alert type="error" showIcon message={globalErr} />}
      <Table<ParsedRow>
        size="small"
        rowKey="key"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ y: 320 }}
        locale={{ emptyText: '解析后将在此显示可导入的规则' }}
      />
      <div style={{ textAlign: 'right' }}>
        <Button type="primary" loading={importing} disabled={rows.length === 0} onClick={runImport}>
          确认导入
        </Button>
      </div>
    </Space>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      destroyOnClose
      title={`规则导入导出 · ${configName}`}
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'export' | 'import')}
        items={[
          { key: 'export', label: '导出', children: exportTab },
          { key: 'import', label: '导入', children: importTab },
        ]}
      />
    </Modal>
  );
};

export default RulesTransferModal;
