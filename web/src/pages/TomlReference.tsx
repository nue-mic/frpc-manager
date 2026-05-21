import { useMemo, useState } from 'react';
import {
  Card,
  Row,
  Col,
  Typography,
  Space,
  Tag,
  Button,
  Menu,
  App,
  theme as antdTheme,
} from 'antd';
import {
  CopyOutlined,
  DownloadOutlined,
  CodeOutlined,
  BookOutlined,
} from '@ant-design/icons';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import {
  TOML_SNIPPETS,
  defaultSnippet,
  findSnippet,
  type Snippet,
} from './tomlSnippets';

const { Title, Text, Paragraph } = Typography;

const VSCODE_MONO = `'Cascadia Code', 'Cascadia Mono', Consolas, 'SF Mono', Menlo, Monaco, 'Roboto Mono', 'Fira Code', 'JetBrains Mono', 'Source Code Pro', 'Liberation Mono', 'Courier New', monospace`;

const refEditorTheme = EditorView.theme({
  '&': { fontFamily: VSCODE_MONO, fontSize: '13.5px' },
  '.cm-content': { fontFamily: VSCODE_MONO, fontVariantLigatures: 'contextual', caretColor: '#fff' },
  '.cm-gutters': { fontFamily: VSCODE_MONO, fontSize: '12.5px' },
  '.cm-scroller': { lineHeight: '1.55' },
});

const refExtensions = [StreamLanguage.define(toml), refEditorTheme, EditorView.editable.of(false)];

const TomlReference: React.FC = () => {
  const { message } = App.useApp();
  const { token } = antdTheme.useToken();
  const [groupKey, setGroupKey] = useState<string>(defaultSnippet().groupKey);
  const [itemKey, setItemKey] = useState<string>(defaultSnippet().itemKey);

  const current: Snippet | undefined = useMemo(() => findSnippet(groupKey, itemKey), [groupKey, itemKey]);

  // 把 TOML_SNIPPETS 渲染成 antd Menu 的 items 结构（group → SubMenu）
  const menuItems = useMemo(() =>
    TOML_SNIPPETS.map((g) => ({
      key: g.key,
      label: g.label,
      type: 'group' as const,
      children: g.items.map((it) => ({
        key: `${g.key}/${it.key}`,
        label: it.title,
      })),
    })),
    []);

  const handleSelect = (key: string) => {
    const [g, i] = key.split('/');
    if (g && i) {
      setGroupKey(g);
      setItemKey(i);
    }
  };

  const handleCopyCurrent = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.toml);
      message.success(`已复制片段「${current.title}」到剪贴板`);
    } catch {
      message.error('复制失败，浏览器可能不允许访问剪贴板');
    }
  };

  const handleDownloadCurrent = () => {
    if (!current) return;
    const blob = new Blob([current.toml], { type: 'application/toml' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${current.key}.toml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const handleCopyAll = async () => {
    const all = TOML_SNIPPETS.map((g) =>
      g.items.map((it) => `\n# ====== ${g.label} / ${it.title} ======\n${it.toml}`).join('\n')
    ).join('\n');
    try {
      await navigator.clipboard.writeText(all);
      message.success(`已复制全部 ${TOML_SNIPPETS.reduce((a, g) => a + g.items.length, 0)} 个片段`);
    } catch {
      message.error('复制失败');
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
        <Space direction="vertical" size={4}>
          <Title level={4} style={{ margin: 0 }}>
            <BookOutlined /> TOML 配置参考
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            基于 frp v0.68 官方示例整理的中文注释配置片段集 · 左侧切换主题 · 右上角一键复制 / 下载
            · 支持 <Text code>Ctrl+F</Text> 在片段内搜索
          </Text>
        </Space>
      </Card>

      <Row gutter={16}>
        {/* 左：分类菜单 */}
        <Col xs={24} md={6} lg={5}>
          <Card
            styles={{ body: { padding: 0 } }}
            style={{ borderRadius: 10, position: 'sticky', top: 76 }}
          >
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
              <Space size={8}>
                <CodeOutlined style={{ color: token.colorPrimary }} />
                <Text strong style={{ fontSize: 13 }}>分类索引</Text>
                <Tag color="cyan" bordered={false}>{TOML_SNIPPETS.reduce((n, g) => n + g.items.length, 0)} 个片段</Tag>
              </Space>
            </div>
            <Menu
              mode="inline"
              items={menuItems}
              selectedKeys={[`${groupKey}/${itemKey}`]}
              onClick={({ key }) => handleSelect(key as string)}
              style={{ borderInlineEnd: 'none', maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' }}
            />
            <div style={{ padding: 12, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
              <Button
                block
                size="small"
                icon={<CopyOutlined />}
                onClick={handleCopyAll}
              >
                一次性复制所有片段
              </Button>
            </div>
          </Card>
        </Col>

        {/* 右：片段详情 + CodeMirror */}
        <Col xs={24} md={18} lg={19}>
          {current && (
            <Card styles={{ body: { padding: 20 } }} style={{ borderRadius: 10 }}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }} wrap>
                  <Space direction="vertical" size={2}>
                    <Space size={8}>
                      <Tag color="cyan" bordered={false}>{TOML_SNIPPETS.find((g) => g.key === groupKey)?.label}</Tag>
                      <Title level={5} style={{ margin: 0 }}>{current.title}</Title>
                    </Space>
                    <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                      {current.hint}
                    </Paragraph>
                  </Space>
                  <Space>
                    <Button icon={<CopyOutlined />} onClick={handleCopyCurrent} type="primary">
                      复制片段
                    </Button>
                    <Button icon={<DownloadOutlined />} onClick={handleDownloadCurrent}>
                      下载 .toml
                    </Button>
                  </Space>
                </Space>

                <div
                  style={{
                    border: '1px solid #1f2933',
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: '#0b0f14',
                    boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.5)',
                  }}
                >
                  <CodeMirror
                    value={current.toml}
                    theme={oneDark}
                    extensions={refExtensions}
                    height="calc(100vh - 320px)"
                    minHeight="420px"
                    maxHeight="78vh"
                    basicSetup={{
                      lineNumbers: true,
                      foldGutter: true,
                      highlightActiveLine: false,
                      bracketMatching: true,
                      searchKeymap: true,
                    }}
                    readOnly
                  />
                </div>

                <Text type="secondary" style={{ fontSize: 12 }}>
                  数据源：fatedier/frp v0.68 + 本项目 pkg/config · 配置实测能被「配置校验」与「高级 TOML 配置」解析通过
                </Text>
              </Space>
            </Card>
          )}
        </Col>
      </Row>
    </Space>
  );
};

export default TomlReference;
