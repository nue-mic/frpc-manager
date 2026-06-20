/**
 * 复制文本到剪贴板，兼容「非安全上下文」。
 *
 * 浏览器的 `navigator.clipboard` 仅在安全上下文(HTTPS 或 localhost)下存在；
 * 通过 http:// + 局域网 IP 访问(如 OpenWrt 后台)时它是 undefined，直接调用
 * `navigator.clipboard.writeText` 会抛 "Cannot read properties of undefined"。
 * 这里优先用 Clipboard API，不可用 / 被拒绝时回退到隐藏 textarea +
 * `document.execCommand('copy')`。
 *
 * @returns 是否复制成功
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1) 安全上下文：优先 Clipboard API
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 安全上下文里也可能因权限/焦点被拒绝 —— 继续走兜底
  }

  // 2) 兜底：textarea + execCommand('copy')，适用于 http 局域网等非安全上下文
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
