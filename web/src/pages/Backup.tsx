import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  CloudDownloadOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  ExperimentOutlined,
  EditOutlined,
  DeleteOutlined,
  RollbackOutlined,
  DownloadOutlined,
} from '@ant-design/icons';
import {
  listChannels,
  listSchedules,
  listRuns,
  createChannel,
  updateChannel,
  deleteChannel,
  testChannel,
  testChannelConfig,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  toggleSchedule,
  runSchedule,
  listChannelObjects,
  restoreFromChannel,
  downloadChannelObject,
  type BackupChannel,
  type BackupSchedule,
  type BackupRun,
  type BackupObject,
  type ChannelInput,
  type ChannelKind,
} from '../api/backup';
import { useEventSubscription } from '../events/EventStreamContext';

const { Title, Text, Paragraph } = Typography;

const DEFAULT_TEMPLATE = 'frpcmgr-backups/{schedule}/{year}/{month}/frpcmgr-{date}-{time}.zip';

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: '每天 03:00', value: '0 3 * * *' },
  { label: '每 6 小时', value: '0 */6 * * *' },
  { label: '每小时', value: '@hourly' },
  { label: '每周日 04:00', value: '0 4 * * 0' },
];

function fmtTime(unix?: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString();
}

function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function statusTag(status?: string) {
  switch (status) {
    case 'success':
      return <Tag color="success">成功</Tag>;
    case 'failed':
      return <Tag color="error">失败</Tag>;
    case 'running':
      return <Tag color="processing">进行中</Tag>;
    default:
      return <Tag>—</Tag>;
  }
}

const Backup: React.FC = () => {
  const { message, modal } = App.useApp();

  const [channels, setChannels] = useState<BackupChannel[]>([]);
  const [schedules, setSchedules] = useState<BackupSchedule[]>([]);
  const [runs, setRuns] = useState<BackupRun[]>([]);

  const reloadChannels = useCallback(async () => {
    try {
      setChannels(await listChannels());
    } catch {
      /* 未登录/网络问题静默 */
    }
  }, []);
  const reloadSchedules = useCallback(async () => {
    try {
      setSchedules(await listSchedules());
    } catch {
      /* silent */
    }
  }, []);
  const reloadRuns = useCallback(async () => {
    try {
      setRuns(await listRuns(50));
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    listChannels().then(setChannels).catch(() => undefined);
    listSchedules().then(setSchedules).catch(() => undefined);
    listRuns(50).then(setRuns).catch(() => undefined);
  }, []);

  // 备份完成（含手动/定时）即时刷新计划状态与历史。
  useEventSubscription(['backup.run'], () => {
    void reloadSchedules();
    void reloadRuns();
  });

  const channelName = useCallback(
    (id: string) => channels.find((c) => c.id === id)?.name || id,
    [channels]
  );

  // ---------- 渠道表单 ----------
  const [chForm] = Form.useForm();
  const [chModal, setChModal] = useState<{ open: boolean; editing?: BackupChannel }>({ open: false });
  const [chSaving, setChSaving] = useState(false);
  const [chTesting, setChTesting] = useState(false);
  const chKind: ChannelKind = Form.useWatch('kind', chForm) ?? 's3';

  const openChannelModal = (editing?: BackupChannel) => {
    setChModal({ open: true, editing });
    if (editing) {
      chForm.setFieldsValue({
        kind: editing.kind,
        name: editing.name,
        s3_endpoint: editing.s3?.endpoint,
        s3_region: editing.s3?.region,
        s3_bucket: editing.s3?.bucket,
        s3_access_key_id: editing.s3?.access_key_id,
        s3_secret: '',
        s3_prefix: editing.s3?.prefix,
        s3_use_ssl: editing.s3?.use_ssl ?? true,
        s3_path_style: editing.s3?.path_style ?? false,
        dav_base_url: editing.webdav?.base_url,
        dav_username: editing.webdav?.username,
        dav_password: '',
        dav_prefix: editing.webdav?.prefix,
      });
    } else {
      chForm.resetFields();
      chForm.setFieldsValue({ kind: 's3', s3_use_ssl: true, s3_path_style: false });
    }
  };

  const buildChannelInput = (vals: Record<string, unknown>): ChannelInput => {
    const kind = vals.kind as ChannelKind;
    const input: ChannelInput = {
      name: (vals.name as string)?.trim(),
      kind,
    };
    if (chModal.editing) input.id = chModal.editing.id;
    if (kind === 's3') {
      input.s3 = {
        endpoint: ((vals.s3_endpoint as string) || '').trim(),
        region: ((vals.s3_region as string) || '').trim(),
        bucket: ((vals.s3_bucket as string) || '').trim(),
        access_key_id: ((vals.s3_access_key_id as string) || '').trim(),
        secret_access_key: (vals.s3_secret as string) || '',
        prefix: ((vals.s3_prefix as string) || '').trim(),
        use_ssl: !!vals.s3_use_ssl,
        path_style: !!vals.s3_path_style,
      };
    } else {
      input.webdav = {
        base_url: ((vals.dav_base_url as string) || '').trim(),
        username: ((vals.dav_username as string) || '').trim(),
        password: (vals.dav_password as string) || '',
        prefix: ((vals.dav_prefix as string) || '').trim(),
      };
    }
    return input;
  };

  const onTestChannel = async () => {
    let vals: Record<string, unknown>;
    try {
      vals = await chForm.validateFields();
    } catch {
      return;
    }
    setChTesting(true);
    try {
      // 编辑已存渠道且密钥留空时，测试已保存的渠道（用库内原始 endpoint+密钥），
      // 而不是把存量密钥发往表单里可能被改过的地址——避免密钥被导向外部。
      const secretBlank = vals.kind === 's3' ? !vals.s3_secret : !vals.dav_password;
      const r =
        chModal.editing && secretBlank
          ? await testChannel(chModal.editing.id)
          : await testChannelConfig(buildChannelInput(vals));
      if (r.ok) message.success('连接成功');
      else message.error('连接失败：' + (r.error || '未知错误'));
    } catch {
      message.error('测试请求失败');
    } finally {
      setChTesting(false);
    }
  };

  const onSaveChannel = async () => {
    let vals: Record<string, unknown>;
    try {
      vals = await chForm.validateFields();
    } catch {
      return;
    }
    setChSaving(true);
    try {
      const input = buildChannelInput(vals);
      if (chModal.editing) await updateChannel(chModal.editing.id, input);
      else await createChannel(input);
      message.success('渠道已保存');
      setChModal({ open: false });
      await reloadChannels();
    } catch (e) {
      message.error('保存失败：' + errMsg(e));
    } finally {
      setChSaving(false);
    }
  };

  const onDeleteChannel = (ch: BackupChannel) => {
    modal.confirm({
      title: `删除渠道「${ch.name}」？`,
      content: '若有备份计划引用该渠道，需先删除/改绑相关计划。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteChannel(ch.id);
          message.success('已删除');
          await reloadChannels();
        } catch (e) {
          message.error('删除失败：' + errMsg(e));
        }
      },
    });
  };

  // ---------- 计划表单 ----------
  const [scForm] = Form.useForm();
  const [scModal, setScModal] = useState<{ open: boolean; editing?: BackupSchedule }>({ open: false });
  const [scSaving, setScSaving] = useState(false);

  const openScheduleModal = (editing?: BackupSchedule) => {
    if (channels.length === 0) {
      message.warning('请先添加至少一个存储渠道');
      return;
    }
    setScModal({ open: true, editing });
    if (editing) {
      scForm.setFieldsValue({
        name: editing.name,
        channel_id: editing.channel_id,
        cron: editing.cron,
        path_template: editing.path_template,
        retention: editing.retention,
        enabled: editing.enabled,
      });
    } else {
      scForm.resetFields();
      scForm.setFieldsValue({
        cron: '0 3 * * *',
        path_template: DEFAULT_TEMPLATE,
        retention: 14,
        enabled: true,
        channel_id: channels[0]?.id,
      });
    }
  };

  const onSaveSchedule = async () => {
    let vals: Record<string, unknown>;
    try {
      vals = await scForm.validateFields();
    } catch {
      return;
    }
    setScSaving(true);
    try {
      const input = {
        name: (vals.name as string).trim(),
        channel_id: vals.channel_id as string,
        cron: (vals.cron as string).trim(),
        path_template: ((vals.path_template as string) || '').trim(),
        retention: (vals.retention as number) ?? 0,
        enabled: !!vals.enabled,
      };
      if (scModal.editing) await updateSchedule(scModal.editing.id, input);
      else await createSchedule(input);
      message.success('备份计划已保存');
      setScModal({ open: false });
      await reloadSchedules();
    } catch (e) {
      message.error('保存失败：' + errMsg(e));
    } finally {
      setScSaving(false);
    }
  };

  const onToggleSchedule = async (s: BackupSchedule) => {
    try {
      await toggleSchedule(s.id);
      await reloadSchedules();
    } catch (e) {
      message.error('切换失败：' + errMsg(e));
    }
  };

  const onRunSchedule = async (s: BackupSchedule) => {
    try {
      await runSchedule(s.id);
      message.success('已触发备份，请稍候查看历史');
      await reloadSchedules();
    } catch (e) {
      message.error('触发失败：' + errMsg(e));
    }
  };

  const onDeleteSchedule = (s: BackupSchedule) => {
    modal.confirm({
      title: `删除备份计划「${s.name}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteSchedule(s.id);
          message.success('已删除');
          await reloadSchedules();
        } catch (e) {
          message.error('删除失败：' + errMsg(e));
        }
      },
    });
  };

  // ---------- 从备份恢复（独立抽屉，低频功能）----------
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreChannel, setRestoreChannel] = useState<string | undefined>(undefined);
  const [restoreObjects, setRestoreObjects] = useState<BackupObject[]>([]);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreTruncated, setRestoreTruncated] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  const onDownload = async (obj: BackupObject) => {
    if (!restoreChannel) return;
    setDownloadingKey(obj.key);
    try {
      const blob = await downloadChannelObject(restoreChannel, obj.key);
      const url = window.URL.createObjectURL(new Blob([blob]));
      const a = document.createElement('a');
      a.href = url;
      a.download = obj.key.split('/').pop() || 'frpcmgr-backup.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      message.error('下载失败：' + errMsg(e));
    } finally {
      setDownloadingKey(null);
    }
  };

  const loadRestoreObjects = useCallback(async (channelId: string) => {
    setRestoreLoading(true);
    setRestoreObjects([]);
    try {
      const r = await listChannelObjects(channelId);
      setRestoreObjects(r.objects);
      setRestoreTruncated(r.truncated);
    } catch (e) {
      message.error('拉取备份列表失败：' + errMsg(e));
    } finally {
      setRestoreLoading(false);
    }
  }, [message]);

  const openRestore = () => {
    if (channels.length === 0) {
      message.warning('请先添加至少一个存储渠道');
      return;
    }
    const ch = restoreChannel && channels.some((c) => c.id === restoreChannel) ? restoreChannel : channels[0].id;
    setRestoreChannel(ch);
    setRestoreOpen(true);
    void loadRestoreObjects(ch);
  };

  const onRestore = (obj: BackupObject) => {
    if (!restoreChannel) return;
    modal.confirm({
      title: '从此备份恢复？',
      width: 520,
      content: (
        <div style={{ fontSize: 13 }}>
          <Paragraph style={{ marginBottom: 8 }}>
            将下载并恢复：<Text code>{obj.key}</Text>
          </Paragraph>
          <Paragraph type="warning" style={{ marginBottom: 0 }}>
            这会<strong>覆盖同名的 FRPC 实例配置</strong>，并恢复品牌 / 系统设置 / 备份渠道与计划；
            备份中不包含的实例不受影响。建议恢复前先做一次当前配置的导出。
          </Paragraph>
        </div>
      ),
      okText: '确认恢复',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setRestoringKey(obj.key);
        try {
          const r = await restoreFromChannel(restoreChannel, obj.key);
          const parts: string[] = [`已恢复 ${r.imported.length} 个实例配置`];
          if (r.branding_restored) parts.push('品牌');
          if (r.system_config_restored) parts.push('系统设置');
          if (r.backup_restored) parts.push('备份渠道/计划');
          message.success(parts.join('，') + '。可到「FRPC 实例」查看');
          // 备份渠道/计划可能已变，刷新本页数据。
          await Promise.all([reloadChannels(), reloadSchedules(), reloadRuns()]);
        } catch (e) {
          message.error('恢复失败：' + errMsg(e));
        } finally {
          setRestoringKey(null);
        }
      },
    });
  };

  const restoreCols: ColumnsType<BackupObject> = useMemo(
    () => [
      {
        title: '备份文件',
        dataIndex: 'key',
        render: (k: string) => (
          <Text style={{ fontSize: 12, maxWidth: 380 }} ellipsis={{ tooltip: k }} copyable={{ text: k }}>
            {k}
          </Text>
        ),
      },
      { title: '大小', dataIndex: 'size', width: 90, render: (n: number) => fmtSize(n) },
      { title: '时间', dataIndex: 'modified', width: 170, render: (n: number) => fmtTime(n) },
      {
        title: '操作',
        width: 160,
        render: (_: unknown, o: BackupObject) => (
          <Space size={4}>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              loading={downloadingKey === o.key}
              onClick={() => onDownload(o)}
            >
              下载
            </Button>
            <Button
              size="small"
              type="primary"
              ghost
              danger
              icon={<RollbackOutlined />}
              loading={restoringKey === o.key}
              onClick={() => onRestore(o)}
            >
              恢复
            </Button>
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [restoringKey, downloadingKey, restoreChannel]
  );

  // ---------- 表格列 ----------
  const channelCols: ColumnsType<BackupChannel> = useMemo(
    () => [
      { title: '名称', dataIndex: 'name', render: (v: string) => <Text strong>{v}</Text> },
      {
        title: '类型',
        dataIndex: 'kind',
        width: 90,
        render: (k: ChannelKind) =>
          k === 's3' ? <Tag color="geekblue">S3</Tag> : <Tag color="cyan">WebDAV</Tag>,
      },
      {
        title: '目标',
        render: (_: unknown, c: BackupChannel) => (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {c.kind === 's3'
              ? `${c.s3?.bucket || '?'} @ ${c.s3?.endpoint || '?'}`
              : c.webdav?.base_url || '?'}
          </Text>
        ),
      },
      {
        title: '凭据',
        width: 90,
        render: (_: unknown, c: BackupChannel) => {
          const set = c.kind === 's3' ? c.s3?.secret_access_key_set : c.webdav?.password_set;
          return set ? <Tag color="success">已配置</Tag> : <Tag color="warning">未配置</Tag>;
        },
      },
      {
        title: '操作',
        width: 180,
        render: (_: unknown, c: BackupChannel) => (
          <Space size={4}>
            <Button size="small" icon={<EditOutlined />} onClick={() => openChannelModal(c)}>
              编辑
            </Button>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDeleteChannel(c)} />
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const scheduleCols: ColumnsType<BackupSchedule> = useMemo(
    () => [
      { title: '名称', dataIndex: 'name', render: (v: string) => <Text strong>{v}</Text> },
      {
        title: '规则 (cron)',
        dataIndex: 'cron',
        render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text>,
      },
      { title: '渠道', dataIndex: 'channel_id', render: (id: string) => channelName(id) },
      { title: '保留', dataIndex: 'retention', width: 70, render: (n: number) => (n > 0 ? n : '不限') },
      {
        title: '启用',
        width: 80,
        render: (_: unknown, s: BackupSchedule) => (
          <Switch size="small" checked={s.enabled} onChange={() => onToggleSchedule(s)} />
        ),
      },
      {
        title: '最近备份',
        render: (_: unknown, s: BackupSchedule) =>
          s.running ? (
            <Tag color="processing">备份中…</Tag>
          ) : s.last_run ? (
            <Space size={6}>
              {statusTag(s.last_run.status)}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {fmtTime(s.last_run.started_at)}
              </Text>
            </Space>
          ) : (
            <Text type="secondary">尚未执行</Text>
          ),
      },
      {
        title: '操作',
        width: 200,
        render: (_: unknown, s: BackupSchedule) => (
          <Space size={4}>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<ThunderboltOutlined />}
              loading={s.running}
              onClick={() => onRunSchedule(s)}
            >
              立即备份
            </Button>
            <Button size="small" icon={<EditOutlined />} onClick={() => openScheduleModal(s)} />
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDeleteSchedule(s)} />
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels]
  );

  const runCols: ColumnsType<BackupRun> = useMemo(
    () => [
      { title: '时间', dataIndex: 'started_at', width: 170, render: (v: number) => fmtTime(v) },
      {
        title: '计划',
        dataIndex: 'schedule_id',
        render: (id: string) => schedules.find((s) => s.id === id)?.name || id,
      },
      {
        title: '触发',
        dataIndex: 'trigger',
        width: 80,
        render: (t: string) => (t === 'manual' ? <Tag>手动</Tag> : <Tag color="blue">定时</Tag>),
      },
      { title: '状态', dataIndex: 'status', width: 90, render: (s: string) => statusTag(s) },
      { title: '大小', dataIndex: 'size_bytes', width: 90, render: (n: number) => fmtSize(n) },
      {
        title: '对象路径 / 错误',
        render: (_: unknown, r: BackupRun) =>
          r.status === 'failed' ? (
            <Tooltip title={r.error}>
              <Text type="danger" style={{ fontSize: 12 }} ellipsis>
                {r.error || '失败'}
              </Text>
            </Tooltip>
          ) : (
            <Text
              style={{ fontSize: 12, maxWidth: 360 }}
              ellipsis={{ tooltip: r.object_path }}
              copyable={r.object_path ? { text: r.object_path } : false}
            >
              {r.object_path || '—'}
            </Text>
          ),
      },
    ],
    [schedules]
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <Space direction="vertical" size={4}>
            <Title level={4} style={{ margin: 0 }}>
              <CloudUploadOutlined /> 定时备份
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              配置存储渠道（S3 / WebDAV），再设定定时计划，把全部配置自动打包上传到云端。渠道与计划存于服务端，
              重启 / 更新 / 备份还原都不丢失。
            </Text>
          </Space>
          <Tooltip title="从某个渠道上已有的备份文件里挑一个，一键恢复配置">
            <Button icon={<CloudDownloadOutlined />} onClick={openRestore}>
              从备份恢复…
            </Button>
          </Tooltip>
        </div>
      </Card>

      <Card
        title={<Space><CloudUploadOutlined /> 存储渠道</Space>}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openChannelModal()}>
            新增渠道
          </Button>
        }
        styles={{ body: { padding: 0 } }}
        style={{ borderRadius: 10 }}
      >
        <Table
          rowKey="id"
          size="middle"
          columns={channelCols}
          dataSource={channels}
          pagination={false}
          locale={{ emptyText: '还没有存储渠道，点右上角「新增渠道」开始' }}
        />
      </Card>

      <Card
        title={<Space><ThunderboltOutlined /> 备份计划</Space>}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openScheduleModal()}>
            新增计划
          </Button>
        }
        styles={{ body: { padding: 0 } }}
        style={{ borderRadius: 10 }}
      >
        <Table
          rowKey="id"
          size="middle"
          columns={scheduleCols}
          dataSource={schedules}
          pagination={false}
          locale={{ emptyText: '还没有备份计划' }}
        />
      </Card>

      <Card
        title={<Space><ReloadOutlined /> 备份历史</Space>}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => reloadRuns()}>刷新</Button>}
        styles={{ body: { padding: 0 } }}
        style={{ borderRadius: 10 }}
      >
        <Table
          rowKey="id"
          size="small"
          columns={runCols}
          dataSource={runs}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: '暂无备份记录' }}
        />
      </Card>

      {/* 渠道弹窗 */}
      <Modal
        title={chModal.editing ? '编辑存储渠道' : '新增存储渠道'}
        open={chModal.open}
        onCancel={() => setChModal({ open: false })}
        width={560}
        footer={[
          <Button key="test" icon={<ExperimentOutlined />} loading={chTesting} onClick={onTestChannel}>
            测试连接
          </Button>,
          <Button key="cancel" onClick={() => setChModal({ open: false })}>取消</Button>,
          <Button key="ok" type="primary" loading={chSaving} onClick={onSaveChannel}>保存</Button>,
        ]}
        destroyOnClose
      >
        <Form form={chForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：我的 R2 / 坚果云" maxLength={60} />
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 's3', label: 'S3 兼容（AWS S3 / 阿里云 OSS / Cloudflare R2 / MinIO …）' },
                { value: 'webdav', label: 'WebDAV（Nextcloud / 坚果云 / 群晖 …）' },
              ]}
            />
          </Form.Item>

          {chKind === 's3' ? (
            <>
              <Form.Item name="s3_endpoint" label="Endpoint" rules={[{ required: true, message: '必填' }]}
                extra="不含 http(s):// 前缀，例如 s3.amazonaws.com、xxx.r2.cloudflarestorage.com">
                <Input placeholder="s3.amazonaws.com" />
              </Form.Item>
              <Space style={{ width: '100%' }} size={12}>
                <Form.Item name="s3_bucket" label="Bucket" rules={[{ required: true, message: '必填' }]} style={{ flex: 1, minWidth: 200 }}>
                  <Input placeholder="my-backups" />
                </Form.Item>
                <Form.Item name="s3_region" label="Region" style={{ flex: 1, minWidth: 160 }}>
                  <Input placeholder="us-east-1 / auto" />
                </Form.Item>
              </Space>
              <Form.Item name="s3_access_key_id" label="Access Key ID" rules={[{ required: true, message: '必填' }]}>
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item name="s3_secret" label="Secret Access Key"
                extra={chModal.editing ? '留空 = 保持当前密钥不变' : undefined}>
                <Input.Password autoComplete="new-password" placeholder={chModal.editing ? '••••••（留空保持不变）' : ''} />
              </Form.Item>
              <Form.Item name="s3_prefix" label="路径前缀（可选）" extra="桶内的基础子目录，留空则放在桶根">
                <Input placeholder="如 frpc/" />
              </Form.Item>
              <Space size={24}>
                <Form.Item name="s3_use_ssl" label="HTTPS" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="s3_path_style" label="Path-Style 寻址" valuePropName="checked"
                  tooltip="MinIO / 部分 OSS 需开启">
                  <Switch />
                </Form.Item>
              </Space>
            </>
          ) : (
            <>
              <Form.Item name="dav_base_url" label="WebDAV 地址" rules={[{ required: true, message: '必填' }]}
                extra="例如 https://dav.jianguoyun.com/dav/">
                <Input placeholder="https://dav.example.com/dav/" />
              </Form.Item>
              <Form.Item name="dav_username" label="用户名">
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item name="dav_password" label="口令 / 应用密码"
                extra={chModal.editing ? '留空 = 保持当前口令不变' : undefined}>
                <Input.Password autoComplete="new-password" placeholder={chModal.editing ? '••••••（留空保持不变）' : ''} />
              </Form.Item>
              <Form.Item name="dav_prefix" label="路径前缀（可选）" extra="根下的基础子目录">
                <Input placeholder="如 frpc" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      {/* 计划弹窗 */}
      <Modal
        title={scModal.editing ? '编辑备份计划' : '新增备份计划'}
        open={scModal.open}
        onCancel={() => setScModal({ open: false })}
        width={560}
        onOk={onSaveSchedule}
        confirmLoading={scSaving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={scForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="计划名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：每日备份" maxLength={60} />
          </Form.Item>
          <Form.Item name="channel_id" label="存储渠道" rules={[{ required: true, message: '请选择渠道' }]}>
            <Select
              options={channels.map((c) => ({
                value: c.id,
                label: `${c.name}（${c.kind === 's3' ? 'S3' : 'WebDAV'}）`,
              }))}
            />
          </Form.Item>
          <Form.Item name="cron" label="定时规则 (cron)" rules={[{ required: true, message: '请输入 cron' }]}
            extra="标准 5 段 cron，或 @hourly / @daily / @every 6h 描述符（按服务器本地时区触发）">
            <Input placeholder="0 3 * * *" />
          </Form.Item>
          <Form.Item label="快捷规则" style={{ marginTop: -8 }}>
            <Space wrap size={6}>
              {CRON_PRESETS.map((p) => (
                <Button key={p.value} size="small" onClick={() => scForm.setFieldValue('cron', p.value)}>
                  {p.label}
                </Button>
              ))}
            </Space>
          </Form.Item>
          <Form.Item name="path_template" label="路径模板"
            extra="占位符：{schedule} {host} {year} {month} {day} {date} {time} {ts}（时间按 UTC）">
            <Input placeholder={DEFAULT_TEMPLATE} />
          </Form.Item>
          <Space size={24} style={{ width: '100%' }}>
            <Form.Item name="retention" label="保留份数" tooltip="只保留最近 N 个备份，0 = 不限">
              <InputNumber min={0} max={9999} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            备份内容 = 全部 FRPC 实例配置 + 服务端元数据（meta.json），与「导入/导出」的整体备份一致。
          </Paragraph>
        </Form>
      </Modal>

      {/* 从备份恢复（独立抽屉） */}
      <Drawer
        title={<Space><CloudDownloadOutlined /> 从备份恢复</Space>}
        width={680}
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            这里直接读取所选渠道上<strong>实际存在的备份文件</strong>（与下方「备份历史」的本机执行记录不同）。
            挑一个点「恢复」，会下载该备份并还原配置。
          </Text>
          <Space wrap>
            <Select
              style={{ minWidth: 260 }}
              value={restoreChannel}
              onChange={(v) => {
                setRestoreChannel(v);
                void loadRestoreObjects(v);
              }}
              options={channels.map((c) => ({
                value: c.id,
                label: `${c.name}（${c.kind === 's3' ? 'S3' : 'WebDAV'}）`,
              }))}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={restoreLoading}
              onClick={() => restoreChannel && loadRestoreObjects(restoreChannel)}
            >
              刷新
            </Button>
          </Space>
          {restoreTruncated && (
            <Text type="warning" style={{ fontSize: 12 }}>
              备份较多，仅显示最近 500 个。
            </Text>
          )}
          <Table
            rowKey="key"
            size="small"
            loading={restoreLoading}
            columns={restoreCols}
            dataSource={restoreObjects}
            pagination={{ pageSize: 12, hideOnSinglePage: true }}
            locale={{
              emptyText: <Empty description="该渠道上还没有备份文件（或路径前缀下为空）" />,
            }}
          />
        </Space>
      </Drawer>
    </Space>
  );
};

function errMsg(e: unknown): string {
  const err = e as { response?: { data?: { error?: { message?: string } } } };
  return err.response?.data?.error?.message || '请检查输入与网络';
}

export default Backup;
