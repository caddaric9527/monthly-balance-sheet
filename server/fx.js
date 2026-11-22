import { getConfig } from './db.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

let fxCache = { rates: null, at: 0 };

/**
 * 汇率表，以 USD 为基准：{ USD: 1, CNY: 7.1, HKD: 7.8 }
 * fx_source=manual 时用设置里的 fx_usd_cny / fx_hkd_cny（后者是 1 HKD 兑多少 CNY）
 */
export async function fetchFx(force = false) {
  const TTL = 6 * 3600 * 1000;
  if (!force && fxCache.rates && Date.now() - fxCache.at < TTL) return fxCache.rates;

  const cfg = getConfig();
  const manual = {
    USD: 1,
    CNY: cfg.fx_usd_cny,
    HKD: cfg.fx_usd_cny / (cfg.fx_hkd_cny || 0.92),
  };
  if (cfg.fx_source === 'manual') return manual;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.result !== 'success' || !data.rates?.CNY) throw new Error('汇率接口异常');
    const rates = { USD: 1, CNY: Number(data.rates.CNY), HKD: Number(data.rates.HKD) || manual.HKD };
    fxCache = { rates, at: Date.now() };
    return rates;
  } catch {
    return manual;
  }
}

/** 单币种 -> 人民币乘数 */
export function cnyRate(rates, currency) {
  if (!currency || currency === 'CNY') return 1;
  const perUsd = Number(rates?.[currency]);
  const usdCny = Number(rates?.CNY) || 1;
  if (!perUsd) return 1;
  return usdCny / perUsd;
}

export const round2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
