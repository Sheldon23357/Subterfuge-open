import React, { useEffect, useState } from 'react';

interface ProviderConfig { id: string; name: string; baseUrl: string; apiKey: string; models: string[]; }
const presets: ProviderConfig[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', models: [] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', models: [] },
  { id: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', models: ['gemini-4-argon'] },
];
function load(): ProviderConfig[] {
  try {
    const saved = JSON.parse(localStorage.getItem('abyss-model-providers') ?? 'null');
    if (Array.isArray(saved)) return presets.map(item => ({ ...item, ...(saved.find((v: ProviderConfig) => v?.id === item.id) ?? {}) }));
  } catch { /* use defaults */ }
  return presets;
}
export function configuredProviders() { return load(); }
function cleanApiKey(value: string) {
  return value.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
}
export function ModelConfigPanel({ defaultModel, onDefaultModel }: { defaultModel: string; onDefaultModel: (model: string) => void }) {
  const [providers, setProviders] = useState(load), [selected, setSelected] = useState('deepseek'), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const current = providers.find(item => item.id === selected) ?? providers[0];
  useEffect(() => { localStorage.setItem('abyss-model-providers', JSON.stringify(providers)); }, [providers]);
  if (!current) return null;
  const provider = current;
  const update = (patch: Partial<ProviderConfig>) => setProviders(items => items.map(item => item.id === provider.id ? { ...item, ...patch } : item));
  async function readModels() {
    setBusy(true); setMessage('');
    try {
      const apiKey = cleanApiKey(provider.apiKey);
      if (!apiKey) throw Error('请先填写 API Key');
      if (!/^[\x00-\x7F]+$/.test(apiKey)) throw Error('API Key 含有非 ASCII 字符，请重新粘贴有效密钥');
      if (apiKey !== provider.apiKey) update({ apiKey });
      const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      const value = await response.json();
      if (!response.ok || !Array.isArray(value.data)) throw Error(value.error?.message ?? '模型列表读取失败');
      const models = value.data.map((item: { id?: unknown }) => item.id).filter((id: unknown): id is string => typeof id === 'string').sort();
      update({ models }); setMessage(`已读取 ${models.length} 个模型`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '模型列表读取失败'); }
    finally { setBusy(false); }
  }
  return <section className="model-config-panel" aria-label="模型配置">
    <div className="provider-tabs">{providers.map(item => <button key={item.id} className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)}>{item.name}</button>)}</div>
    <p className="hint">预置常用供应商。密钥只保存在此浏览器，用于读取模型列表；实际 AI 调用仍需服务端选择对应 Provider。</p>
    <label className="setting-row"><span>API 地址<small>可改为代理或自托管兼容地址</small></span><input value={provider.baseUrl} onChange={e => update({ baseUrl: e.target.value })} /></label>
    <label className="setting-row"><span>API Key<small>不会显示在 AI 日志中</small></span><input type="password" value={provider.apiKey} onChange={e => update({ apiKey: e.target.value })} placeholder="填写后读取模型" /></label>
    <div className="model-config-actions"><button disabled={busy || !provider.apiKey.trim()} onClick={() => void readModels()}>{busy ? '读取中…' : '自动读取模型'}</button>{message && <span className="hint">{message}</span>}</div>
    <label className="setting-row"><span>Bot 默认模型<small>AI Bot 配置可直接快捷选择</small></span><select value={defaultModel} onChange={e => onDefaultModel(e.target.value)}><option value="">不指定</option>{provider.models.map(model => <option value={model} key={model}>{model}</option>)}</select></label>
    {provider.models.length > 0 && <p className="model-list">{provider.models.join(' · ')}</p>}
  </section>;
}
