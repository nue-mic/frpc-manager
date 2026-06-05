import { useEffect, useState } from 'react';
import {
  Card,
  Space,
  Typography,
  Form,
  Button,
  Switch,
  Divider,
  Descriptions,
  Tag,
  App,
  Row,
  Col,
  Alert,
  theme as antdTheme,
} from 'antd';
import {
  UserOutlined,
  SettingOutlined,
  InfoCircleOutlined,
  GithubOutlined,
  SafetyCertificateOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import client, { clearAPIToken, getAPIToken } from '../api/client';
import { useTheme } from '../theme/ThemeContext';

const { Title, Text, Paragraph } = Typography;

interface VersionResp {
  daemon?: string;
  version?: string;
  frp?: string;
  build_date?: string;
}

const APP_REPO = 'https://github.com/mia-clark/frpc-manager';

const Settings: React.FC = () => {
  const { token } = antdTheme.useToken();
  const { message, modal } = App.useApp();
  const { mode, setMode, resolved } = useTheme();

  const [autoCollapse, setAutoCollapse] = useState<boolean>(
    () => localStorage.getItem('frpmgr_sidebar_collapse') === '1'
  );
  const [version, setVersion] = useState<VersionResp>({});
  const tokenMasked = (() => {
    const t = getAPIToken();
    if (!t) return '未保存';
    if (t.length <= 8) return '****';
    return `${t.slice(0, 4)}…${t.slice(-4)}`;
  })();

  useEffect(() => {
    client.get<VersionResp>('/api/v1/version').then((r) => setVersion(r.data)).catch(() => undefined);
  }, []);

  const onChangeToken = () => {
    modal.confirm({
      title: '更换 API Token？',
      content: '这会清除当前保存的 Token 并跳转回登录页，请确保新的 Token 已准备好。',
      okText: '我已准备好',
      cancelText: '取消',
      onOk: () => {
        clearAPIToken();
        message.success('已清除本地 Token');
        window.location.href = '/login';
      },
    });
  };

  const onToggleSidebar = (v: boolean) => {
    setAutoCollapse(v);
    localStorage.setItem('frpmgr_sidebar_collapse', v ? '1' : '0');
    message.success('已保存，下次刷新生效');
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
        <Space direction="vertical" size={4}>
          <Title level={4} style={{ margin: 0 }}>
            <SettingOutlined /> 设置
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            个性化、账户和版本信息。所有偏好都只保存在浏览器本地，更换设备需要重新设置。
          </Text>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title={<Space><UserOutlined /> 账户</Space>} styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
            <Descriptions column={1} size="small" labelStyle={{ width: 100 }}>
              <Descriptions.Item label="鉴权方式">
                <Tag color="processing" icon={<KeyOutlined />}>Bearer Token</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="当前 Token">
                <Text code>{tokenMasked}</Text>
              </Descriptions.Item>
            </Descriptions>
            <Divider style={{ margin: '16px 0' }} />
            <Space>
              <Button danger onClick={onChangeToken}>更换 / 清除 Token</Button>
            </Space>
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 16, borderRadius: 8 }}
              message="安全提示"
              description={
                <Text style={{ fontSize: 12 }}>
                  Token 被存放在浏览器 localStorage 中，存在被 XSS 读取的风险。生产环境建议结合反向代理 IP 白名单 / Basic Auth 一并加固。
                </Text>
              }
            />
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title={<Space><SettingOutlined /> 外观与交互</Space>} styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
            <Form layout="horizontal" labelCol={{ span: 8 }} wrapperCol={{ span: 16 }}>
              <Form.Item label="主题模式">
                <Space>
                  <Switch
                    checkedChildren="跟随系统"
                    unCheckedChildren="手动"
                    checked={mode === 'system'}
                    onChange={(v) => setMode(v ? 'system' : resolved)}
                  />
                  {mode !== 'system' && (
                    <Switch
                      checkedChildren="深色"
                      unCheckedChildren="浅色"
                      checked={mode === 'dark'}
                      onChange={(v) => setMode(v ? 'dark' : 'light')}
                    />
                  )}
                  <Tag bordered={false}>当前：{resolved === 'dark' ? '深色' : '浅色'}</Tag>
                </Space>
              </Form.Item>
              <Form.Item label="侧边栏默认折叠">
                <Switch checked={autoCollapse} onChange={onToggleSidebar} />
              </Form.Item>
              <Form.Item label="主色">
                <Text code style={{ background: token.colorPrimary, color: '#fff', padding: '2px 8px' }}>
                  {token.colorPrimary}
                </Text>
              </Form.Item>
            </Form>
          </Card>
        </Col>

        <Col xs={24}>
          <Card title={<Space><InfoCircleOutlined /> 关于</Space>} styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
            <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} size="small" labelStyle={{ width: 110 }}>
              <Descriptions.Item label="应用名称">
                <Space>
                  <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />
                  FRPC
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="Daemon 版本">
                <Tag>{version.daemon || version.version || '—'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="嵌入 frp">
                <Tag color="cyan">{version.frp || '—'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="构建时间">{version.build_date || '—'}</Descriptions.Item>
              <Descriptions.Item label="前端栈">
                React 19 · Ant Design 6 · Vite
              </Descriptions.Item>
              <Descriptions.Item label="实时通道">WebSocket (/api/v1/events)</Descriptions.Item>
            </Descriptions>
            <Divider style={{ margin: '16px 0' }} />
            <Space wrap>
              <Button icon={<GithubOutlined />} href={APP_REPO} target="_blank">
                源代码 / Issues
              </Button>
              <Button
                onClick={() => {
                  const a = document.createElement('a');
                  a.href = '/api/v1/version';
                  a.target = '_blank';
                  a.click();
                }}
              >
                查看版本接口
              </Button>
            </Space>
            <Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
              本控制台是 frpmgr 1.26.1 Windows 桌面版功能向 Web 端的完整迁移与扩展，自带多实例管理、可视化规则编辑、TOML 直编、事件流和宿主机监控。
            </Paragraph>
          </Card>
        </Col>
      </Row>
    </Space>
  );
};

export default Settings;
