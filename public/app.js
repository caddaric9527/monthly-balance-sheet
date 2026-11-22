/* 月度资产负债表 · 前端 */

/* ================= 基础工具 ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const SYM = { CNY: '¥', USD: '$', HKD: 'HK$' };

const money = (v, d = 2) => `${SYM.CNY}${n(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const curMoney = (v, cur = 'CNY', d = 2) =>
  `${SYM[cur] || ''}${n(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const short = (v) => {
  const a = Math.abs(n(v));
  if (a >= 1e8) return `${(n(v) / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${(n(v) / 1e4).toFixed(2)}万`;
  return n(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
};
const signed = (v) => `${n(v) > 0 ? '+' : n(v) < 0 ? '-' : ''}${money(Math.abs(n(v)))}`;
const pctText = (v) => (isNum(v) ? `${n(v) > 0 ? '+' : ''}${n(v).toFixed(2)}%` : '—');
const tone = (v) => (!isNum(v) || Math.abs(n(v)) < 0.005 ? 'flat' : n(v) > 0 ? 'up' : 'down');
const deltaTag = (v, d = 2, moneyMode = true) => {
  if (!isNum(v)) return '<span class="delta tag-flat">—</span>';
  const txt = moneyMode ? signed(v) : pctText(v);
  return `<span class="delta tag-${tone(v)}">${txt}</span>`;
};

const KIND = {
  bank: { t: '银行卡', color: '#2e6be6' },
  alipay: { t: '支付宝', color: '#1677ff' },
  wechat: { t: '微信', color: '#07c160' },
  cash: { t: '现金', color: '#b7791f' },
  broker: { t: '券商', color: '#7a5af8' },
  other: { t: '其他', color: '#98a2b3' },
};
const LIAB = { credit: '信用卡', loan: '贷款', borrow: '借款', other: '其他' };
const SERIES = {
  net: { label: '净资产', color: '#2e6be6' },
  assets: { label: '总资产', color: '#7a5af8' },
  cash: { label: '现金', color: '#0f9d8f' },
  invest: { label: '理财', color: '#e08a1e' },
  liabilities: { label: '总负债', color: '#d92f2f' },
};

/* ================= 请求 ================= */
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

/* ================= 提示 / 弹窗 ================= */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 220);
  }, 2400);
}

const mask = $('#modalMask');
function closeModal() {
  mask.classList.remove('open');
  mask.innerHTML = '';
}
mask.addEventListener('click', (e) => {
  if (e.target === mask) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mask.classList.contains('open')) closeModal();
});

function openModal(html, onMount) {
  mask.innerHTML = `<div class="modal">${html}</div>`;
  mask.classList.add('open');
  if (onMount) onMount($('.modal', mask));
}

function confirmBox({ title, text, okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    openModal(
      `<div class="modal-head"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}</div>
       <div class="modal-foot">
         <button class="btn" data-cancel>取消</button>
         <button class="btn ${danger ? 'danger-fill' : 'primary'}" data-ok>${esc(okText)}</button>
       </div>`,
      (m) => {
        m.querySelector('[data-cancel]').onclick = () => {
          closeModal();
          resolve(false);
        };
        m.querySelector('[data-ok]').onclick = () => {
          closeModal();
          resolve(true);
        };
      },
    );
  });
}

/* ================= 状态 ================= */
const state = {
  view: 'overview',
  months: [],
  trend: null,
  config: null,
  authRequired: false,
  ovMonth: null,
  ovSnap: null,
  chartKey: 'net',
  entry: null, // { month, cash[], liabilities[], investment, note, confirmed, fx, meta }
  entryDirty: false,
  settingsDraft: null,
};

const KIND_ORDER = Object.keys(KIND);
const monthShift = (m, delta) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (m) => `${m.slice(0, 4)} 年 ${Number(m.slice(5, 7))} 月`;
const todayMonth = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

/* ================= 图表 ================= */
function niceStep(raw) {
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  const mult = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return mult * exp;
}

const chartRegistry = new Map();

function lineChart(el, rows, key, color) {
  if (!el) return;
  chartRegistry.set(el, { rows, key, color });
  const data = rows.filter((r) => isNum(r[key]));
  if (!data.length) {
    el.innerHTML = '<div class="empty">还没有足够的数据画图</div>';
    return;
  }

  const W = Math.max(300, el.clientWidth || 760);
  const H = 250;
  const P = { l: 56, r: 14, t: 14, b: 26 };
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;

  const vals = data.map((d) => n(d[key]));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) {
    const pad = Math.abs(hi) * 0.12 || 1000;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (lo > 0 && lo / step < 1) lo = 0;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);

  const X = (i) => P.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const Y = (v) => P.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

  const line = data.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(n(d[key])).toFixed(1)}`).join(' ');
  const area = `${line} L${X(data.length - 1).toFixed(1)},${(P.t + ih).toFixed(1)} L${X(0).toFixed(1)},${(
    P.t + ih
  ).toFixed(1)} Z`;

  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  const labelEvery = Math.ceil(data.length / Math.max(4, Math.floor(iw / 68)));
  const xLabels = data
    .map((d, i) => {
      if (i % labelEvery !== 0 && i !== data.length - 1) return '';
      const [y, m] = d.month.split('-');
      const txt = data.length > 12 ? `${Number(m)}月` : `${y.slice(2)}/${m}`;
      const anchor = i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle';
      return `<text x="${X(i)}" y="${H - 8}" font-size="11" fill="#8a94a6" text-anchor="${anchor}">${txt}</text>`;
    })
    .join('');

  el.innerHTML = `
    <div class="chart">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity=".18"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${ticks
          .map(
            (t) => `<line x1="${P.l}" y1="${Y(t)}" x2="${W - P.r}" y2="${Y(t)}" stroke="#eef1f6" stroke-width="1"/>
                    <text x="${P.l - 9}" y="${Y(t) + 4}" font-size="11" fill="#8a94a6" text-anchor="end">${short(t)}</text>`,
          )
          .join('')}
        <path d="${area}" fill="url(#${gid})"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        ${data.length <= 30
          ? data
              .map(
                (d, i) =>
                  `<circle cx="${X(i)}" cy="${Y(n(d[key]))}" r="3.2" fill="#fff" stroke="${color}" stroke-width="2"/>`,
              )
              .join('')
          : ''}
        ${xLabels}
        <g class="hover-layer" opacity="0">
          <line class="cross" y1="${P.t}" y2="${P.t + ih}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3"/>
          <circle class="dot" r="4.5" fill="${color}" stroke="#fff" stroke-width="2"/>
        </g>
        <rect class="hit" x="${P.l}" y="${P.t}" width="${iw}" height="${ih}" fill="transparent" style="cursor:crosshair"/>
      </svg>
      <div class="tooltip"></div>
    </div>`;

  const svg = $('svg', el);
  const hit = $('.hit', el);
  const layer = $('.hover-layer', el);
  const tip = $('.tooltip', el);

  hit.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = data.length === 1 ? 0 : Math.min(data.length - 1, Math.max(0, Math.round(((x - P.l) / iw) * (data.length - 1))));
    const d = data[i];
    const px = X(i);
    const py = Y(n(d[key]));
    layer.setAttribute('opacity', '1');
    $('.cross', layer).setAttribute('x1', px);
    $('.cross', layer).setAttribute('x2', px);
    $('.dot', layer).setAttribute('cx', px);
    $('.dot', layer).setAttribute('cy', py);
    tip.innerHTML = `<div class="t-month">${monthLabel(d.month)}</div>
      <div class="t-row"><span>${SERIES[key].label}</span><span>${money(d[key])}</span></div>
      ${
        key !== 'net' && isNum(d.net)
          ? `<div class="t-row"><span>净资产</span><span>${money(d.net)}</span></div>`
          : ''
      }`;
    tip.style.left = `${px}px`;
    tip.style.top = `${py}px`;
    tip.classList.add('show');
  });
  hit.addEventListener('pointerleave', () => {
    layer.setAttribute('opacity', '0');
    tip.classList.remove('show');
  });
}

const ro = new ResizeObserver((entries) => {
  entries.forEach((en) => {
    const cfg = chartRegistry.get(en.target);
    if (!cfg) return;
    const w = en.contentRect.width;
    if (cfg.lastW && Math.abs(cfg.lastW - w) < 8) return;
    cfg.lastW = w;
    lineChart(en.target, cfg.rows, cfg.key, cfg.color);
  });
});
function mountChart(el, rows, key, color) {
  if (!el) return;
  ro.observe(el);
  lineChart(el, rows, key, color);
}

/* ================= 概览 ================= */
function renderOverview() {
  const el = $('#view-overview');
  const t = state.trend;
  ro.disconnect();
  chartRegistry.clear();
  if (!t || !t.months.length) {
    el.innerHTML = `
      <div class="panel"><div class="empty" style="padding:56px 24px">
        <span class="emoji">🧾</span>
        <div class="title">还没有任何月度记录</div>
        <div>每月月底花三分钟：填现金余额、点一下同步理财，就能看到净资产曲线。</div>
        <div style="margin-top:18px"><button class="btn primary" data-act="goto-entry">立即录入第一份月报</button></div>
      </div></div>`;
    return;
  }

  const monthsDesc = [...t.months].reverse();
  const month = state.ovMonth && t.months.includes(state.ovMonth) ? state.ovMonth : t.months[t.months.length - 1];
  const snap = state.ovSnap && state.ovSnap.month === month ? state.ovSnap : null;
  const tot = snap ? snap.totals : t.trend.find((r) => r.month === month) || t.latest;
  const chg = snap ? snap.change : (t.trend.find((r) => r.month === month) || {}).change || {};
  const prevMonth = snap?.prev?.month;
  const cashCount = snap ? snap.cash.filter((c) => n(c.balance) !== 0).length : 0;
  const inv = snap?.investment || null;
  const detail = inv?.detail || [];
  const liabList = snap?.liabilities || [];

  el.innerHTML = `
    <div class="entry-head" style="margin-bottom:14px">
      <div class="inline" style="gap:12px;flex-wrap:wrap">
        <span class="muted small">数据月份</span>
        <select id="ovMonthSelect" style="width:auto;min-width:130px">
          ${monthsDesc.map((m) => `<option value="${m}" ${m === month ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
        </select>
        ${snap?.meta.confirmed ? '<span class="chip green">月末已确认</span>' : '<span class="chip gray">草稿</span>'}
        ${prevMonth ? `<span class="muted small">环比基准：${monthLabel(prevMonth)}</span>` : '<span class="muted small">首个月份，暂无环比</span>'}
      </div>
      <div class="inline">
        <button class="btn small" data-act="open-month" data-month="${month}">编辑这个月</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi hero">
        <div class="k-label">净资产 <span style="opacity:.7">· 总资产 − 总负债</span></div>
        <div class="k-value">${money(tot.net)}</div>
        <div class="k-sub">
          ${isNum(chg.net) ? `<span class="delta" style="background:rgba(255,255,255,.18);color:#fff">${chg.net >= 0 ? '▲' : '▼'} ${money(Math.abs(chg.net))}${isNum(chg.netPct) ? ` · ${pctText(chg.netPct)}` : ''}</span>` : '<span>首月记录</span>'}
          <span style="opacity:.75">较上月</span>
        </div>
      </div>
      <div class="kpi">
        <div class="k-label"><span class="dot" style="background:#7a5af8"></span>总资产</div>
        <div class="k-value">${money(tot.assets)}</div>
        <div class="k-sub">负债 ${money(tot.liabilities)}${isNum(tot.liabilityRatio) ? ` · 负债率 ${tot.liabilityRatio.toFixed(1)}%` : ''}</div>
        <div class="k-bar"><i style="width:${Math.min(100, n(tot.liabilityRatio))}%;background:#d92f2f;opacity:.55"></i></div>
      </div>
      <div class="kpi">
        <div class="k-label"><span class="dot" style="background:#0f9d8f"></span>现金</div>
        <div class="k-value">${money(tot.cash)}</div>
        <div class="k-sub">占资产 ${isNum(tot.cashShare) ? tot.cashShare.toFixed(1) : '—'}% · ${cashCount} 个账户有余额</div>
        <div class="k-bar"><i style="width:${Math.min(100, n(tot.cashShare))}%;background:#0f9d8f"></i></div>
      </div>
      <div class="kpi">
        <div class="k-label"><span class="dot" style="background:#e08a1e"></span>理财</div>
        <div class="k-value">${money(tot.invest)}</div>
        <div class="k-sub">${
          tot.investInvested > 0
            ? `成本 ${money(tot.investInvested)} · <span class="${tone(tot.investGain)}">${signed(tot.investGain)}（${pctText(tot.investReturnPct)}）</span>`
            : '尚未录入理财市值'
        }</div>
        <div class="k-bar"><i style="width:${Math.min(100, n(tot.investShare))}%;background:#e08a1e"></i></div>
      </div>
    </div>

    <section class="panel">
      <div class="panel-head">
        <h2>资产走势 <span class="hint">共 ${t.months.length} 个月记录</span></h2>
        <div class="seg" id="seriesSeg">
          ${Object.entries(SERIES)
            .map(
              ([k, v]) =>
                `<button data-series="${k}" class="${k === state.chartKey ? 'active' : ''}">${v.label}</button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="panel-body" style="padding:8px 12px 4px"><div id="trendChart"></div></div>
      <div class="stats">
        <div class="s"><div class="l">区间最高</div><div class="v">${money(Math.max(...t.trend.map((r) => n(r.net))))}</div></div>
        <div class="s"><div class="l">区间最低</div><div class="v">${money(Math.min(...t.trend.map((r) => n(r.net))))}</div></div>
        <div class="s"><div class="l">累计变化</div><div class="v ${tone(n(t.trend[t.trend.length - 1].net) - n(t.trend[0].net))}">${signed(n(t.trend[t.trend.length - 1].net) - n(t.trend[0].net))}</div></div>
        <div class="s"><div class="l">月均变化</div><div class="v">${t.trend.length > 1 ? signed((n(t.trend[t.trend.length - 1].net) - n(t.trend[0].net)) / (t.trend.length - 1)) : '—'}</div></div>
      </div>
    </section>

    <div class="grid-3">
      <section class="panel">
        <div class="panel-head"><h2>资产结构</h2><span class="hint">${monthLabel(month)}</span></div>
        <div class="panel-body">
          <div class="stack-bar">
            <i style="width:${n(tot.cashShare)}%;background:#0f9d8f"></i>
            <i style="width:${n(tot.investShare)}%;background:#e08a1e"></i>
          </div>
          <div class="legend">
            <div class="item"><span class="dot" style="background:#0f9d8f"></span>现金 <b>${money(tot.cash)}</b> <span class="muted">${isNum(tot.cashShare) ? tot.cashShare.toFixed(1) : 0}%</span></div>
            <div class="item"><span class="dot" style="background:#e08a1e"></span>理财 <b>${money(tot.invest)}</b> <span class="muted">${isNum(tot.investShare) ? tot.investShare.toFixed(1) : 0}%</span></div>
          </div>
          <div style="border-top:1px dashed var(--border);margin:14px 0 12px"></div>
          <div class="bars">
            <div class="bar-row">
              <div class="bar-top"><span>负债占资产</span><span class="mono">${isNum(tot.liabilityRatio) ? tot.liabilityRatio.toFixed(2) + '%' : '—'}</span></div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, n(tot.liabilityRatio))}%;background:#d92f2f"></div></div>
            </div>
            <div class="bar-row">
              <div class="bar-top"><span>理财收益 / 成本</span><span class="mono ${tone(tot.investReturnPct)}">${isNum(tot.investReturnPct) ? pctText(tot.investReturnPct) : '—'}</span></div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, Math.max(0, n(tot.investReturnPct)))}%;background:#e08a1e"></div></div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>现金分布</h2><span class="hint">钱放在哪儿</span></div>
        <div class="panel-body">
          ${cashBars(snap)}
        </div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head">
        <h2>理财持仓明细</h2>
        <span class="hint">${
          inv?.source === 'db'
            ? '来自 portfolio-tracker（数据库直读）'
            : inv?.source === 'api'
              ? '来自 portfolio-tracker（接口同步）'
              : inv?.source === 'manual'
                ? '手动填写'
                : '未录入'
        }${inv?.syncedAt ? ` · 同步于 ${new Date(inv.syncedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</span>
      </div>
      <div class="table-wrap">
        ${
          detail.length
            ? `<table>
                  <thead><tr><th>组合</th><th>币种</th><th>记录月</th><th class="r">市值（原币）</th><th class="r">成本（原币）</th><th class="r">折人民币</th><th class="r">收益率</th></tr></thead>
                <tbody>${detail
                  .map((d) => {
                    const gain = n(d.valueCny) - n(d.investedCny);
                    const rp = n(d.investedCny) > 0 ? (gain / n(d.investedCny)) * 100 : null;
                    return `<tr>
                      <td>${esc(d.name)}</td>
                      <td><span class="chip gray">${esc(d.currency)}</span></td>
                      <td class="muted">${esc(d.month)}${d.exact === false ? ' <span class="chip outline">沿用</span>' : ''}</td>
                      <td class="r mono">${curMoney(d.value, d.currency)}</td>
                      <td class="r mono muted">${curMoney(d.invested, d.currency)}</td>
                      <td class="r mono">${money(d.valueCny)}</td>
                      <td class="r mono ${tone(rp)}">${pctText(rp)}</td>
                    </tr>`;
                  })
                  .join('')}
                  <tr class="total-row">
                    <td colspan="3">合计（折人民币）</td>
                    <td class="r mono"></td>
                    <td class="r mono">${money(tot.investInvested)}</td>
                    <td class="r mono">${money(tot.invest)}</td>
                    <td class="r mono ${tone(tot.investReturnPct)}">${pctText(tot.investReturnPct)}</td>
                  </tr>
                </tbody></table>`
            : `<div class="empty">还没有理财持仓明细。<br/>在「设置」里连上 portfolio-tracker 后，每月点击同步即可自动带入。</div>`
        }
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>与上月对比</h2><span class="hint">${prevMonth ? `${monthLabel(prevMonth)} → ${monthLabel(month)}` : '暂无上月数据'}</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>项目</th><th class="r">上月</th><th class="r">本月</th><th class="r">变化</th><th class="r">变化率</th></tr></thead>
          <tbody>
            ${[
              ['总资产', 'assets'],
              ['　现金', 'cash'],
              ['　理财', 'invest'],
              ['总负债', 'liabilities'],
              ['净资产', 'net'],
            ]
              .map(([label, k]) => {
                const cur = n(tot[k]);
                const prev = snap?.prev ? n(snap.prev.totals[k]) : null;
                const d = snap?.prev ? cur - prev : null;
                const r = snap?.prev && Math.abs(prev) > 0.004 ? (d / Math.abs(prev)) * 100 : null;
                const isNet = k === 'net';
                return `<tr class="${isNet ? 'total-row' : ''}">
                  <td>${label}</td>
                  <td class="r mono muted">${snap?.prev ? money(prev) : '—'}</td>
                  <td class="r mono">${money(cur)}</td>
                  <td class="r mono ${tone(d)}">${isNum(d) ? signed(d) : '—'}</td>
                  <td class="r mono ${tone(r)}">${pctText(r)}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      ${
        liabList.length
          ? `<div class="panel-body" style="border-top:1px solid var(--border);padding-top:12px">
              <div class="muted small" style="margin-bottom:6px">本月负债明细</div>
              <div class="inline" style="flex-wrap:wrap;gap:6px">
                ${liabList.map((l) => `<span class="chip red">${esc(l.name)} · ${money(l.amountCny)}</span>`).join('')}
              </div>
            </div>`
          : ''
      }
    </section>`;

  mountChart($('#trendChart'), t.trend, state.chartKey, SERIES[state.chartKey].color);
}

function cashBars(snap) {
  const rows = (snap?.cash || []).filter((c) => n(c.balance) !== 0).sort((a, b) => b.balanceCny - a.balanceCny);
  if (!rows.length) return '<div class="empty" style="padding:20px">这个月还没有现金余额</div>';
  const total = rows.reduce((s, r) => s + n(r.balanceCny), 0) || 1;
  return `<div class="bars">${rows
    .map((r) => {
      const share = (n(r.balanceCny) / total) * 100;
      const color = KIND[r.kind]?.color || '#98a2b3';
      return `<div class="bar-row">
        <div class="bar-top">
          <span>${esc(r.name)} <span class="muted small">${KIND[r.kind]?.t || ''}</span></span>
          <span class="mono">${money(r.balanceCny)} <span class="muted">${share.toFixed(1)}%</span></span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${share}%;background:${color}"></div></div>
      </div>`;
    })
    .join('')}</div>`;
}

/* ================= 录入页 ================= */
function entryMonthDefault() {
  const saved = localStorage.getItem('bs_entry_month');
  const months = state.months;
  const now = todayMonth();
  if (months.length) {
    const latest = months[months.length - 1];
    const next = monthShift(latest, 1);
    if (!months.includes(now) && next <= now && next > latest) return next;
    if (!months.includes(now)) return now;
    return now;
  }
  if (saved) return saved;
  const d = new Date().getDate();
  return d < 20 ? monthShift(now, -1) : now;
}

async function loadEntry(month) {
  const snap = await api(`/snapshot/${month}`);
  state.entry = {
    month,
    cash: snap.cash.map((c) => ({ ...c })),
    liabilities: snap.liabilities.map((l) => ({
      name: l.name,
      kind: l.kind,
      amount: l.amount,
      currency: l.currency,
      note: l.note || '',
    })),
    investment: { ...snap.investment },
    note: snap.meta.note || '',
    confirmed: snap.meta.confirmed,
    fx: snap.fx,
    prev: snap.prev,
    meta: snap.meta,
  };
  state.entryDirty = false;
  localStorage.setItem('bs_entry_month', month);
  renderEntry();
}

function entryRate(cur) {
  const fx = state.entry?.fx || { usd: 7.1, hkd: 0.92 };
  if (cur === 'USD') return n(fx.usd);
  if (cur === 'HKD') return n(fx.hkd);
  return 1;
}

function entryTotals() {
  const e = state.entry;
  if (!e) return { cash: 0, invest: 0, liabilities: 0, assets: 0, net: 0 };
  const cash = e.cash.reduce((s, c) => s + n(c.balance) * entryRate(c.currency), 0);
  const liabilities = e.liabilities.reduce((s, l) => s + n(l.amount) * entryRate(l.currency), 0);
  const invest = n(e.investment.valueCny);
  const assets = cash + invest;
  return { cash, invest, liabilities, assets, net: assets - liabilities };
}

function renderEntry() {
  const el = $('#view-entry');
  const e = state.entry;
  if (!e) {
    el.innerHTML = '<div class="panel"><div class="empty">加载中…</div></div>';
    return;
  }
  const totals = entryTotals();
  const filled = e.cash.filter((c) => c.saved).length;
  const mode = state.config?.portfolio_mode || 'manual';
  const modeText = { manual: '手动填写', api: '接口同步', db: '数据库直读' }[mode] || mode;
  const inv = e.investment;

  el.innerHTML = `
    <div class="entry-head">
      <div class="month-nav">
        <button class="round-btn" data-act="month-prev" title="上一月" aria-label="上一月">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
        </button>
        <input type="month" id="monthPick" class="month-input" value="${e.month}" title="选择月份">
        <button class="round-btn" data-act="month-next" title="下一月" aria-label="下一月" ${e.month >= todayMonth() ? 'disabled style="opacity:.35"' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
        </button>
      </div>
      <div class="inline" style="flex-wrap:wrap;gap:8px">
        ${e.confirmed ? '<span class="chip green">月末已确认</span>' : '<span class="chip gray">草稿</span>'}
        <span class="muted small">现金已填 ${filled}/${e.cash.length} 个账户</span>
        <button class="btn small" data-act="add-account">＋ 新增账户</button>
      </div>
    </div>

    <section class="panel">
      <div class="panel-head">
        <h2>① 现金余额 <span class="hint">按「钱放在哪儿」逐个账户填</span></h2>
        <div class="inline">
          <button class="btn small" data-act="carry-all" ${e.cash.length ? '' : 'disabled'}>沿用上月全部</button>
        </div>
      </div>
      <div class="table-wrap">
        ${
          e.cash.length
            ? `<table class="entry-table">
                <thead>
                  <tr>
                    <th>位置 / 账户</th><th>类型</th><th class="r">上月余额</th>
                    <th class="r" style="width:170px">本月余额</th><th class="r">折人民币</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  ${e.cash
                    .map(
                      (c) => `<tr data-cash-row="${c.accountId}">
                        <td>
                          <div class="acct-name">
                            <span class="nm">${esc(c.name)}</span>
                            ${c.currency !== 'CNY' ? `<span class="chip gray">${c.currency}</span>` : ''}
                            ${!c.saved && c.carried ? '<span class="carry-hint warn">沿用上月</span>' : ''}
                          </div>
                          ${c.note ? `<div class="acct-name sub">${esc(c.note)}</div>` : ''}
                        </td>
                        <td><span class="chip" style="background:${hexA(KIND[c.kind]?.color || '#98a2b3', 0.12)};color:${KIND[c.kind]?.color || '#98a2b3'}">${KIND[c.kind]?.t || '其他'}</span></td>
                        <td class="r mono prev">${c.prevBalance === null ? '—' : curMoney(c.prevBalance, c.currency)}</td>
                        <td class="r"><input class="money" type="number" step="0.01" inputmode="decimal" data-cash-input="${c.accountId}" value="${c.balance === 0 && !c.saved ? '' : c.balance}" placeholder="0.00"></td>
                        <td class="r mono" data-cash-cny="${c.accountId}">${money(n(c.balance) * entryRate(c.currency))}</td>
                        <td class="r"><button class="btn-link" data-act="edit-account" data-id="${c.accountId}" title="编辑账户">编辑</button></td>
                      </tr>`,
                    )
                    .join('')}
                  <tr class="total-row">
                    <td colspan="3">现金合计</td>
                    <td class="r mono" id="cashTotal">${money(totals.cash)}</td>
                    <td class="r mono" id="cashTotal2">${money(totals.cash)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>`
            : `<div class="empty"><span class="emoji">💳</span><div class="title">先添加你的现金账户</div>
                银行卡、支付宝、微信零钱、券商现金…每个「钱放的地方」建一个。<br/>
                <div style="margin-top:14px"><button class="btn primary" data-act="add-account">＋ 添加账户</button></div></div>`
        }
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>② 理财市值 <span class="hint">来自投资组合收益统计</span></h2>
        <div class="inline">
          <span class="chip ${mode === 'manual' ? 'gray' : 'purple'}">${modeText}</span>
          ${
            mode !== 'manual'
              ? `<button class="btn small primary" data-act="sync-invest">同步本月理财</button>`
              : `<button class="btn small" data-act="goto-settings">连接 portfolio-tracker</button>`
          }
        </div>
      </div>
      <div class="panel-body">
        ${
          inv.detail?.length
            ? `<div class="table-wrap" style="margin:-16px -18px 12px">
                <table>
                  <thead><tr><th>组合</th><th>币种</th><th>记录月</th><th class="r">市值</th><th class="r">成本</th><th class="r">折人民币</th></tr></thead>
                  <tbody>${inv.detail
                    .map(
                      (d) => `<tr>
                        <td>${esc(d.name)}</td>
                        <td class="muted">${esc(d.currency)}</td>
                        <td class="muted">${esc(d.month)}${d.exact === false ? ' <span class="chip outline">沿用</span>' : ''}</td>
                        <td class="r mono">${curMoney(d.value, d.currency)}</td>
                        <td class="r mono muted">${curMoney(d.invested, d.currency)}</td>
                        <td class="r mono">${money(d.valueCny)}</td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                </table>
              </div>`
            : ''
        }
        <div class="row-2">
          <div class="field" style="margin-bottom:0">
            <label>理财市值（人民币）</label>
            <input class="money" type="number" step="0.01" id="invValue" value="${inv.valueCny || ''}" placeholder="0.00">
            <div class="help">${
              inv.source ? `当前来源：${modeText}${inv.syncedAt ? `，同步于 ${new Date(inv.syncedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}` : '手动填写，或者连接 portfolio-tracker 自动同步'
            }</div>
          </div>
          <div class="field" style="margin-bottom:0">
            <label>投入成本（人民币，选填）</label>
            <input class="money" type="number" step="0.01" id="invInvested" value="${inv.investedCny || ''}" placeholder="0.00">
            <div class="help">用于计算持仓收益率，同步时会自动带入</div>
          </div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>③ 负债 <span class="hint">信用卡、房贷、借款…没有就留空</span></h2>
        <button class="btn small" data-act="add-liab">＋ 添加负债</button>
      </div>
      <div class="table-wrap">
        ${
          e.liabilities.length
            ? `<table class="entry-table">
                <thead><tr><th>名称</th><th style="width:120px">类型</th><th class="r" style="width:160px">金额</th><th style="width:100px">币种</th><th class="r">折人民币</th><th></th></tr></thead>
                <tbody>
                  ${e.liabilities
                    .map(
                      (l, i) => `<tr>
                        <td><input type="text" data-liab-name="${i}" value="${esc(l.name)}" placeholder="如 招行信用卡"></td>
                        <td><select data-liab-kind="${i}">${Object.entries(LIAB)
                          .map(([k, v]) => `<option value="${k}" ${l.kind === k ? 'selected' : ''}>${v}</option>`)
                          .join('')}</select></td>
                        <td><input class="money" type="number" step="0.01" data-liab-amount="${i}" value="${l.amount || ''}" placeholder="0.00"></td>
                        <td><select data-liab-cur="${i}">${['CNY', 'USD', 'HKD']
                          .map((c) => `<option value="${c}" ${l.currency === c ? 'selected' : ''}>${c}</option>`)
                          .join('')}</select></td>
                        <td class="r mono" data-liab-cny="${i}">${money(n(l.amount) * entryRate(l.currency))}</td>
                        <td class="r"><button class="btn-link danger" data-act="del-liab" data-idx="${i}">删除</button></td>
                      </tr>`,
                    )
                    .join('')}
                  <tr class="total-row"><td colspan="4">负债合计</td><td class="r mono" id="liabTotal">${money(totals.liabilities)}</td><td></td></tr>
                </tbody></table>`
            : '<div class="empty" style="padding:22px">暂无负债记录</div>'
        }
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>备注</h2></div>
      <div class="panel-body" style="padding-top:12px">
        <input type="text" id="monthNote" value="${esc(e.note)}" placeholder="这个月有什么特殊情况？比如年终奖、大额支出、行情波动…（选填）" maxlength="300">
      </div>
    </section>

    <div class="savebar">
      <div class="sums">
        <div class="sum"><div class="l">现金</div><div class="v" data-sum="cash">${money(totals.cash)}</div></div>
        <div class="sum"><div class="l">理财</div><div class="v" data-sum="invest">${money(totals.invest)}</div></div>
        <div class="sum"><div class="l">负债</div><div class="v" data-sum="liab">${money(totals.liabilities)}</div></div>
        <div class="sum"><div class="l">净资产</div><div class="v big" data-sum="net">${money(totals.net)}</div></div>
      </div>
      <div class="inline">
        <button class="btn" data-act="toggle-confirm">${e.confirmed ? '取消月末确认' : '标记月末已确认'}</button>
        <button class="btn primary" data-act="save">保存本月数据</button>
      </div>
    </div>`;
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(bigint >> 16) & 255}, ${(bigint >> 8) & 255}, ${bigint & 255}, ${a})`;
}

function refreshEntryNumbers() {
  const e = state.entry;
  if (!e) return;
  const totals = entryTotals();
  e.cash.forEach((c) => {
    const cell = $(`[data-cash-cny="${c.accountId}"]`);
    if (cell) cell.textContent = money(n(c.balance) * entryRate(c.currency));
  });
  e.liabilities.forEach((l, i) => {
    const cell = $(`[data-liab-cny="${i}"]`);
    if (cell) cell.textContent = money(n(l.amount) * entryRate(l.currency));
  });
  const set = (sel, v) => {
    const node = $(sel);
    if (node) node.textContent = v;
  };
  set('#cashTotal', money(totals.cash));
  set('#cashTotal2', money(totals.cash));
  set('#liabTotal', money(totals.liabilities));
  set('[data-sum="cash"]', money(totals.cash));
  set('[data-sum="invest"]', money(totals.invest));
  set('[data-sum="liab"]', money(totals.liabilities));
  set('[data-sum="net"]', money(totals.net));
  state.entryDirty = true;
}

async function saveEntry(confirmedOverride) {
  const e = state.entry;
  if (!e) return;
  const payload = {
    cash: e.cash.map((c) => ({ accountId: c.accountId, balance: n(c.balance) })),
    liabilities: e.liabilities.filter((l) => String(l.name || '').trim()),
    investment: {
      valueCny: n(e.investment.valueCny),
      investedCny: n(e.investment.investedCny),
      source: e.investment.source || 'manual',
      detail: e.investment.detail || [],
      syncedAt: e.investment.syncedAt || null,
    },
    note: e.note,
    confirmed: confirmedOverride === undefined ? e.confirmed : confirmedOverride,
  };
  const btn = $('[data-act="save"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中…';
  }
  try {
    const snap = await api(`/snapshot/${e.month}`, { method: 'PUT', body: payload });
    await refreshAll({ keepEntry: true });
    await loadEntry(e.month);
    toast(`${monthLabel(snap.month)} 已保存`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '保存本月数据';
    }
  }
}

/* ================= 历史 ================= */
function renderHistory() {
  const el = $('#view-history');
  const rows = [...(state.monthRows || [])].reverse();
  if (!rows.length) {
    el.innerHTML = '<div class="panel"><div class="empty"><span class="emoji">📭</span><div class="title">还没有月度记录</div></div></div>';
    return;
  }
  el.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>历史月报</h2><span class="hint">共 ${rows.length} 个月</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>月份</th><th class="r">现金</th><th class="r">理财</th><th class="r">总资产</th>
            <th class="r">负债</th><th class="r">净资产</th><th class="r">环比</th><th>状态</th><th></th>
          </tr></thead>
          <tbody>
            ${rows
              .map((r, i) => {
                const prev = rows[i + 1];
                const d = prev ? n(r.net) - n(prev.net) : null;
                const p = prev && Math.abs(n(prev.net)) > 0.004 ? (d / Math.abs(n(prev.net))) * 100 : null;
                return `<tr class="row-click" data-act="open-month" data-month="${r.month}">
                  <td><b>${monthLabel(r.month)}</b></td>
                  <td class="r mono">${money(r.cash)}</td>
                  <td class="r mono">${money(r.invest)}</td>
                  <td class="r mono">${money(r.assets)}</td>
                  <td class="r mono">${r.liabilities ? money(r.liabilities) : '<span class="muted">—</span>'}</td>
                  <td class="r mono"><b>${money(r.net)}</b></td>
                  <td class="r mono ${tone(d)}">${isNum(d) ? `${signed(d)} <span class="muted">${pctText(p)}</span>` : '—'}</td>
                  <td>${r.confirmed ? '<span class="chip green">已确认</span>' : '<span class="chip gray">草稿</span>'}</td>
                  <td class="r"><button class="btn-link danger" data-act="del-month" data-month="${r.month}">删除</button></td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

/* ================= 设置 ================= */
function renderSettings() {
  const el = $('#view-settings');
  const cfg = state.config || {};
  const mode = cfg.portfolio_mode || 'manual';
  el.innerHTML = `
    <div class="settings-grid">
      <section class="panel">
        <div class="panel-head"><h2>理财数据源</h2><span class="hint">portfolio-tracker</span></div>
        <div class="panel-body">
          <div class="notice">理财部分不用重复录入：每月点一次「同步」，就会把投资组合收益统计里各组合的市值折算成人民币带进来。</div>
          <div class="radio-cards" id="modeCards">
            ${[
              ['manual', '手动填写', '不连接，自己填市值'],
              ['db', '数据库直读', '同机部署，读它的 SQLite'],
              ['api', '接口同步', '通过 HTTP 接口读取'],
            ]
              .map(
                ([k, t, d]) => `<button class="radio-card ${mode === k ? 'active' : ''}" data-mode="${k}">
                  <div class="t">${t}</div><div class="d">${d}</div></button>`,
              )
              .join('')}
          </div>

          <div id="modeFields" style="margin-top:14px">
            <div class="field" data-for="db">
              <label>数据库文件路径</label>
              <input type="text" id="cfgDbPath" value="${esc(cfg.portfolio_db_path || '')}" placeholder="/data/portfolio/portfolio.db">
              <div class="help">Docker 部署时把对方的 data 目录只读挂载进来，例如 <code>-v /path/portfolio/data:/data/portfolio:ro</code>${
                cfg.envOverride?.portfolio_db_path ? '（当前被环境变量 PORTFOLIO_DB 覆盖）' : ''
              }</div>
            </div>
            <div class="field" data-for="api">
              <label>服务地址</label>
              <input type="text" id="cfgBaseUrl" value="${esc(cfg.portfolio_base_url || '')}" placeholder="http://192.168.1.10:8888">
              <div class="help">${
                cfg.envOverride?.portfolio_base_url ? '当前被环境变量 PORTFOLIO_BASE_URL 覆盖。' : ''
              }同机部署可填 http://127.0.0.1:8888</div>
            </div>
            <div class="field" data-for="api">
              <label>访问密码</label>
              <input type="password" id="cfgPassword" value="" placeholder="${cfg.has_portfolio_password ? '已保存，留空表示不修改' : 'portfolio-tracker 的登录密码'}">
              <div class="help">${cfg.envOverride?.portfolio_password ? '当前被环境变量 PORTFOLIO_PASSWORD 覆盖。' : '只存在本机的数据库里，不会外传'}</div>
            </div>
          </div>

          <div class="inline" style="margin-top:6px">
            <button class="btn primary" data-act="save-portfolio">保存配置</button>
            <button class="btn" data-act="test-portfolio">测试连接</button>
          </div>
          <div id="testResult" style="margin-top:10px"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>汇率</h2><span class="hint">外币资产折算人民币</span></div>
        <div class="panel-body">
          <div class="seg" id="fxSeg" style="margin-bottom:14px">
            <button data-fx="auto" class="${cfg.fx_source !== 'manual' ? 'active' : ''}">自动获取</button>
            <button data-fx="manual" class="${cfg.fx_source === 'manual' ? 'active' : ''}">手动固定</button>
          </div>
          <div class="row-2">
            <div class="field">
              <label>1 美元 = ? 人民币</label>
              <input class="money" type="number" step="0.0001" id="fxUsd" value="${cfg.fx_usd_cny || ''}" ${cfg.fx_source !== 'manual' ? 'disabled' : ''}>
            </div>
            <div class="field">
              <label>1 港币 = ? 人民币</label>
              <input class="money" type="number" step="0.0001" id="fxHkd" value="${cfg.fx_hkd_cny || ''}" ${cfg.fx_source !== 'manual' ? 'disabled' : ''}>
            </div>
          </div>
          <div class="inline">
            <button class="btn" data-act="refresh-fx">立即刷新汇率</button>
            <button class="btn primary" data-act="save-fx">保存</button>
          </div>
          <div class="help" style="margin-top:8px">每个月的汇率会在保存时记录一次，历史月份的人民币金额不会因为汇率变化而漂移。</div>
        </div>
      </section>
    </div>

    <div class="settings-grid" style="margin-top:0">
      <section class="panel">
        <div class="panel-head"><h2>数据备份</h2></div>
        <div class="panel-body">
          <div class="inline" style="flex-wrap:wrap">
            <button class="btn" data-act="export">导出 JSON</button>
            <label class="btn" style="cursor:pointer">导入 JSON<input type="file" id="importFile" accept="application/json,.json" hidden></label>
          </div>
          <div class="help" style="margin-top:8px">建议每月导出一次存到自己电脑里。导入默认合并，同月份会被覆盖。</div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>关于</h2></div>
        <div class="panel-body">
          <div class="small" style="line-height:1.9">
            <div>月度资产负债表 <span class="chip gray">v${esc(cfg.version || 'dev')}</span></div>
            <div class="muted">理财数据来自同系列项目「投资组合收益统计」。</div>
            <div class="muted">所有数据存在本机 SQLite，不上传任何服务器。</div>
          </div>
        </div>
      </section>
    </div>`;

  syncModeFields(mode);
}

function syncModeFields(mode) {
  $$('#modeFields [data-for]').forEach((f) => {
    f.hidden = f.dataset.for !== mode;
  });
}

/* ================= 视图切换 & 数据加载 ================= */
async function refreshAll({ keepEntry = false } = {}) {
  const [monthsRes, trendRes, cfgRes] = await Promise.all([api('/months'), api('/trend?limit=48'), api('/config')]);
  state.months = monthsRes.months.map((m) => m.month);
  state.monthRows = monthsRes.months;
  state.trend = trendRes;
  state.config = cfgRes;

  if (!state.ovMonth || !state.months.includes(state.ovMonth)) {
    state.ovMonth = state.months.length ? state.months[state.months.length - 1] : null;
  }
  if (state.ovMonth) {
    state.ovSnap = await api(`/snapshot/${state.ovMonth}`);
  } else {
    state.ovSnap = null;
  }
  if (!keepEntry) state.entry = null;

  const verTag = $('#verTag');
  if (cfgRes.version) {
    verTag.textContent = `v${cfgRes.version}`;
    verTag.hidden = false;
  }
}

function showView(name) {
  state.view = name;
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'overview') renderOverview();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'entry') {
    const month = state.pendingMonth || state.entry?.month || entryMonthDefault();
    state.pendingMonth = null;
    loadEntry(month).catch((e) => toast(e.message, 'err'));
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ================= 账户弹窗 ================= */
function accountModal(account) {
  const isEdit = Boolean(account);
  const a = account || { name: '', kind: 'bank', currency: 'CNY', note: '' };
  openModal(
    `<div class="modal-head">
      <h3>${isEdit ? '编辑账户' : '新增现金账户'}</h3>
      <p>一个账户 = 钱放的一个地方，比如「招行储蓄卡」「支付宝余额」</p>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>名称</label>
        <input type="text" id="accName" value="${esc(a.name)}" placeholder="如 招商银行储蓄卡" maxlength="40" autofocus>
      </div>
      <div class="row-2">
        <div class="field">
          <label>类型</label>
          <select id="accKind">
            ${KIND_ORDER.map((k) => `<option value="${k}" ${a.kind === k ? 'selected' : ''}>${KIND[k].t}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>币种</label>
          <select id="accCur">
            ${['CNY', 'USD', 'HKD'].map((c) => `<option value="${c}" ${a.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>备注（选填）</label>
        <input type="text" id="accNote" value="${esc(a.note || '')}" placeholder="如 工资卡 / 只放应急金" maxlength="100">
      </div>
    </div>
    <div class="modal-foot split">
      ${isEdit ? '<button class="btn danger" data-archive>归档此账户</button>' : '<span></span>'}
      <div class="inline">
        <button class="btn" data-cancel>取消</button>
        <button class="btn primary" data-ok>${isEdit ? '保存' : '添加'}</button>
      </div>
    </div>`,
    (m) => {
      const nameEl = m.querySelector('#accName');
      setTimeout(() => nameEl.focus(), 30);
      m.querySelector('[data-cancel]').onclick = closeModal;
      const submit = async () => {
        const payload = {
          name: nameEl.value.trim(),
          kind: m.querySelector('#accKind').value,
          currency: m.querySelector('#accCur').value,
          note: m.querySelector('#accNote').value.trim(),
        };
        if (!payload.name) return toast('请填账户名称', 'err');
        try {
          if (isEdit) await api(`/accounts/${account.id}`, { method: 'PATCH', body: payload });
          else await api('/accounts', { method: 'POST', body: payload });
          closeModal();
          toast(isEdit ? '账户已更新' : '账户已添加', 'ok');
          await loadEntry(state.entry.month);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
      m.querySelector('[data-ok]').onclick = submit;
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      const arch = m.querySelector('[data-archive]');
      if (arch)
        arch.onclick = async () => {
          const ok = await confirmBox({
            title: '归档账户？',
            text: '归档后不再出现在录入表里，历史数据保留。',
            okText: '归档',
            danger: true,
          });
          if (!ok) return;
          await api(`/accounts/${account.id}`, { method: 'DELETE' });
          closeModal();
          toast('账户已归档', 'ok');
          await loadEntry(state.entry.month);
        };
    },
  );
}

/* ================= 事件绑定 ================= */
document.addEventListener('click', async (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) return showView(tab.dataset.tab);

  const seg = e.target.closest('#seriesSeg button');
  if (seg) {
    state.chartKey = seg.dataset.series;
    $$('#seriesSeg button').forEach((b) => b.classList.toggle('active', b === seg));
    mountChart($('#trendChart'), state.trend.trend, state.chartKey, SERIES[state.chartKey].color);
    return;
  }

  const modeCard = e.target.closest('#modeCards .radio-card');
  if (modeCard) {
    $$('#modeCards .radio-card').forEach((c) => c.classList.toggle('active', c === modeCard));
    syncModeFields(modeCard.dataset.mode);
    return;
  }

  const fxBtn = e.target.closest('#fxSeg button');
  if (fxBtn) {
    $$('#fxSeg button').forEach((b) => b.classList.toggle('active', b === fxBtn));
    const manual = fxBtn.dataset.fx === 'manual';
    $('#fxUsd').disabled = !manual;
    $('#fxHkd').disabled = !manual;
    return;
  }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  try {
    if (act === 'goto-entry') return showView('entry');
    if (act === 'goto-settings') return showView('settings');
    if (act === 'open-month') {
      state.pendingMonth = el.dataset.month;
      state.entry = null;
      showView('entry');
      return;
    }
    if (act === 'month-prev' || act === 'month-next') {
      if (state.entryDirty) {
        const ok = await confirmBox({ title: '放弃未保存的修改？', text: '切换月份会丢失刚才的改动。', okText: '放弃', danger: true });
        if (!ok) return;
      }
      const next = monthShift(state.entry.month, act === 'month-prev' ? -1 : 1);
      return loadEntry(next);
    }
    if (act === 'add-account') return accountModal(null);
    if (act === 'edit-account') {
      const id = Number(el.dataset.id);
      const c = state.entry.cash.find((x) => x.accountId === id);
      return accountModal(c ? { id, name: c.name, kind: c.kind, currency: c.currency, note: c.note } : null);
    }
    if (act === 'carry-all') {
      const e2 = state.entry;
      let count = 0;
      e2.cash.forEach((c) => {
        if (c.prevBalance !== null) {
          c.balance = c.prevBalance;
          c.saved = true;
          count += 1;
        }
      });
      renderEntry();
      toast(count ? `已沿用上月 ${count} 个账户的余额` : '上月没有可沿用的数据', count ? 'ok' : 'err');
      refreshEntryNumbers();
      return;
    }
    if (act === 'add-liab') {
      state.entry.liabilities.push({ name: '', kind: 'credit', amount: 0, currency: 'CNY', note: '' });
      renderEntry();
      const inputs = $$('[data-liab-name]');
      if (inputs.length) inputs[inputs.length - 1].focus();
      return;
    }
    if (act === 'del-liab') {
      state.entry.liabilities.splice(Number(el.dataset.idx), 1);
      renderEntry();
      refreshEntryNumbers();
      return;
    }
    if (act === 'sync-invest') {
      el.disabled = true;
      el.textContent = '同步中…';
      try {
        const res = await api(`/snapshot/${state.entry.month}/sync`, { method: 'POST' });
        state.entry.investment = { ...res.snapshot.investment };
        await refreshAll({ keepEntry: true });
        renderEntry();
        if (res.partial) {
          toast(`已同步 ${res.detail.length} 个组合（部分组合沿用了更早月份的数据）`, 'ok');
        } else {
          toast(`已同步 ${res.detail.length} 个组合，理财市值 ${money(res.valueCny)}`, 'ok');
        }
        if (res.warnings?.length) toast(res.warnings[0], 'err');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        const btn = $('[data-act="sync-invest"]');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '同步本月理财';
        }
      }
      return;
    }
    if (act === 'save') return saveEntry();
    if (act === 'toggle-confirm') {
      const target = !state.entry.confirmed;
      await saveEntry(target);
      return;
    }
    if (act === 'del-month') {
      const month = el.dataset.month;
      const ok = await confirmBox({
        title: `删除 ${monthLabel(month)} 的记录？`,
        text: '该月的现金、负债、理财数据都会被删除，无法恢复。',
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await api(`/snapshot/${month}`, { method: 'DELETE' });
      if (state.entry?.month === month) state.entry = null;
      await refreshAll();
      showView(state.view);
      toast('已删除', 'ok');
      return;
    }
    if (act === 'save-portfolio') {
      const active = $('#modeCards .radio-card.active')?.dataset.mode || 'manual';
      const body = {
        portfolio_mode: active,
        portfolio_base_url: $('#cfgBaseUrl')?.value ?? undefined,
        portfolio_db_path: $('#cfgDbPath')?.value ?? undefined,
      };
      const pw = $('#cfgPassword')?.value;
      if (pw) body.portfolio_password = pw;
      await api('/config', { method: 'PATCH', body });
      await refreshAll({ keepEntry: true });
      state.config = await api('/config');
      renderSettings();
      toast('理财数据源配置已保存', 'ok');
      return;
    }
    if (act === 'test-portfolio') {
      const active = $('#modeCards .radio-card.active')?.dataset.mode || 'manual';
      const box = $('#testResult');
      box.innerHTML = '<span class="muted small">测试中…</span>';
      const res = await api('/config/test', {
        method: 'POST',
        body: {
          portfolio_mode: active,
          portfolio_base_url: $('#cfgBaseUrl')?.value || '',
          portfolio_db_path: $('#cfgDbPath')?.value || '',
          portfolio_password: $('#cfgPassword')?.value || '',
        },
      });
      box.innerHTML = `<div class="notice ${res.ok ? 'ok' : 'warn'}">${res.ok ? '✓' : '✗'} ${esc(res.message)}</div>`;
      return;
    }
    if (act === 'save-fx') {
      const manual = $('#fxSeg button.active')?.dataset.fx === 'manual';
      await api('/config', {
        method: 'PATCH',
        body: {
          fx_source: manual ? 'manual' : 'auto',
          fx_usd_cny: $('#fxUsd').value ? Number($('#fxUsd').value) : undefined,
          fx_hkd_cny: $('#fxHkd').value ? Number($('#fxHkd').value) : undefined,
        },
      });
      await refreshAll({ keepEntry: true });
      renderSettings();
      toast('汇率设置已保存', 'ok');
      return;
    }
    if (act === 'refresh-fx') {
      const r = await api('/fx/refresh', { method: 'POST' });
      $('#fxUsd').value = r.usd;
      $('#fxHkd').value = r.hkd;
      await refreshAll({ keepEntry: true });
      toast(`汇率已更新：1 美元 = ${r.usd}，1 港币 = ${r.hkd}`, 'ok');
      return;
    }
    if (act === 'export') {
      const data = await api('/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `balance-sheet-${new Date().toLocaleDateString('sv-SE')}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出备份', 'ok');
      return;
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* 输入事件 */
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.cashInput !== undefined) {
    const id = Number(t.dataset.cashInput);
    const c = state.entry.cash.find((x) => x.accountId === id);
    if (c) {
      c.balance = t.value === '' ? 0 : Number(t.value);
      c.saved = true;
      state.entryDirty = true;
      refreshEntryNumbers();
    }
    return;
  }
  if (t.id === 'invValue') {
    state.entry.investment.valueCny = t.value === '' ? 0 : Number(t.value);
    state.entry.investment.source = 'manual';
    refreshEntryNumbers();
    return;
  }
  if (t.id === 'invInvested') {
    state.entry.investment.investedCny = t.value === '' ? 0 : Number(t.value);
    refreshEntryNumbers();
    return;
  }
  if (t.id === 'monthNote') {
    state.entry.note = t.value;
    state.entryDirty = true;
    return;
  }
  if (t.dataset.liabName !== undefined) {
    state.entry.liabilities[Number(t.dataset.liabName)].name = t.value;
    state.entryDirty = true;
    return;
  }
  if (t.dataset.liabAmount !== undefined) {
    state.entry.liabilities[Number(t.dataset.liabAmount)].amount = t.value === '' ? 0 : Number(t.value);
    refreshEntryNumbers();
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.liabKind !== undefined) {
    state.entry.liabilities[Number(t.dataset.liabKind)].kind = t.value;
    state.entryDirty = true;
    return;
  }
  if (t.dataset.liabCur !== undefined) {
    state.entry.liabilities[Number(t.dataset.liabCur)].currency = t.value;
    refreshEntryNumbers();
    return;
  }
  if (t.id === 'monthPick' && t.value) {
    if (!/^\d{4}-\d{2}$/.test(t.value)) return;
    if (state.entryDirty) {
      const ok = await confirmBox({ title: '放弃未保存的修改？', text: '切换月份会丢失刚才的改动。', okText: '放弃', danger: true });
      if (!ok) {
        t.value = state.entry.month;
        return;
      }
    }
    loadEntry(t.value);
    return;
  }
  if (t.id === 'ovMonthSelect') {
    state.ovMonth = t.value;
    state.ovSnap = await api(`/snapshot/${t.value}`);
    renderOverview();
    return;
  }
  if (t.id === 'importFile' && t.files?.[0]) {
    const file = t.files[0];
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return toast('文件不是合法的 JSON', 'err');
    }
    const ok = await confirmBox({
      title: '导入备份？',
      text: `将从 ${file.name} 合并导入，同月份的记录会被覆盖。`,
      okText: '导入',
    });
    if (!ok) return;
    try {
      const res = await api('/import', { method: 'POST', body: { data: parsed, mode: 'merge' } });
      await refreshAll();
      showView('history');
      toast(`导入完成：${res.accounts} 个账户、${res.entries} 条余额`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }
});

/* ================= 启动 ================= */
(async function boot() {
  try {
    const session = await api('/session');
    state.authRequired = Boolean(session.authRequired);
    if (state.authRequired) $('#btnLogout').hidden = false;
    await refreshAll();
    const initial = location.hash.slice(1);
    showView(['overview', 'entry', 'history', 'settings'].includes(initial) ? initial : 'overview');
  } catch (e) {
    if (e.message !== '未登录') toast(e.message, 'err');
  }
})();

$('#btnQuickEntry').addEventListener('click', () => {
  state.entry = null;
  showView('entry');
});
$('#btnSettingsTop').addEventListener('click', () => showView('settings'));
$('#btnLogout').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  } catch {
    /* ignore */
  }
});
